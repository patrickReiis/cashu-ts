import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { CashuMint } from './CashuMint.js';
import { BlindedMessage } from './model/BlindedMessage.js';
import {
	type AmountPreference,
	type BlindedMessageData,
	type BlindedTransaction,
	type MeltPayload,
	type MeltQuoteResponse,
	type MintKeys,
	type MintKeyset,
	type MeltTokensResponse,
	type MintPayload,
	type Proof,
	type MintQuotePayload,
	type MeltQuotePayload,
	type SendResponse,
	type SerializedBlindedMessage,
	type SwapPayload,
	type Token,
	type TokenEntry,
	CheckStateEnum,
	SerializedBlindedSignature,
	MeltQuoteState
} from './model/types/index.js';
import {
	bytesToNumber,
	getDecodedToken,
	getDefaultAmountPreference,
	splitAmount
} from './utils.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hashToCurve, pointFromHex } from '@cashu/crypto/modules/common';
import {
	blindMessage,
	constructProofFromPromise,
	serializeProof
} from '@cashu/crypto/modules/client';
import {
	deriveBlindingFactor,
	deriveSecret,
	deriveSeedFromMnemonic
} from '@cashu/crypto/modules/client/NUT09';
import { createP2PKsecret, getSignedProofs } from '@cashu/crypto/modules/client/NUT11';
import { type Proof as NUT11Proof } from '@cashu/crypto/modules/common/index';

/**
 * Class that represents a Cashu wallet.
 * This class should act as the entry point for this library
 */
class CashuWallet {
	private _keys: Map<string, MintKeys> = new Map();
	private _keyset_id: string | undefined;
	private _keysets: Array<MintKeyset> = [];
	private _seed: Uint8Array | undefined;
	private _unit = 'sat';
	mint: CashuMint;

	/**
	 * @param unit optionally set unit
	 * @param keys public keys from the mint. If set, it will override the unit with the keysets unit
	 * @param mint Cashu mint instance is used to make api calls
	 * @param mnemonicOrSeed mnemonic phrase or Seed to initial derivation key for this wallets deterministic secrets. When the mnemonic is provided, the seed will be derived from it.
	 * This can lead to poor performance, in which case the seed should be directly provided
	 */
	constructor(
		mint: CashuMint,
		options?: {
			unit?: string;
			keys?: Array<MintKeys>;
			keysets?: Array<MintKeyset>;
			mnemonicOrSeed?: string | Uint8Array;
		}
	) {
		this.mint = mint;
		if (options?.unit) this._unit = options?.unit;
		if (options?.keys) options.keys.forEach((key) => this._keys.set(key.id, key));
		if (options?.keysets) this._keysets = options.keysets;

		if (!options?.mnemonicOrSeed) {
			return;
		} else if (options?.mnemonicOrSeed instanceof Uint8Array) {
			this._seed = options.mnemonicOrSeed;
		} else {
			if (!validateMnemonic(options.mnemonicOrSeed, wordlist)) {
				throw new Error('Tried to instantiate with mnemonic, but mnemonic was invalid');
			}
			this._seed = deriveSeedFromMnemonic(options.mnemonicOrSeed);
		}
	}

	get unit(): string {
		return this._unit;
	}

	get keys(): MintKeys {
		if (!this._keyset_id || !this._keys.get(this._keyset_id)) {
			throw new Error('Keys are not set');
		}
		return this._keys.get(this._keyset_id) as MintKeys;
	}
	set keys(keys: MintKeys) {
		if (keys.unit !== this._unit) {
			throw new Error('Unit of keyset does not match the unit of the wallet');
		}
		this._keys.set(keys.id, keys);
		this._keyset_id = keys.id;
	}
	get keysets(): Array<MintKeyset> {
		return this._keysets;
	}
	set keysets(keysets: Array<MintKeyset>) {
		this._keysets = keysets;
	}

	/**
	 * Get information about the mint
	 * @returns mint info
	 */
	async getMintInfo() {
		return this.mint.getInfo();
	}

	/**
	 * Load mint information, keysets and keys. This function can be called if no keysets are passed in the constructor
	 */
	async loadMint() {
		await this.getMintInfo();
		if (!this._keys.size) {
			await this.getKeys()
		} else {
			await this.getKeySets();
			// get all keysets from this._keysets which are not already in this._keys
			this._keysets.forEach(async (keyset) => {
				if (!this._keys.get(keyset.id)) {
					await this.getKeys(keyset.id);
				}
			});
		}
	}

	/**
	 * Get keysets from the mint with the unit of the wallet
	 * @returns keysets
	 */
	async getKeySets(): Promise<Array<MintKeyset>> {
		const allKeysets = await this.mint.getKeySets();
		const unitKeysets = allKeysets.keysets.filter((k) => k.unit === this._unit);
		this._keysets = unitKeysets;
		return this._keysets;
	}

	/**
	 * Get public keys from the mint. 
	 * If a keysetId is set, it will fetch and return that speficic keyset.
	 * Otherwise, we select an active keyset with the unit of the wallet.
	 * 
	 * @param keysetId optional keysetId to get keys for
	 * @param unit optional unit to get keys for
	 * @returns keyset
	 */
	async getKeys(keysetId?: string): Promise<MintKeys> {
		if (keysetId) {
			if (this._keys.get(keysetId)) {
				this._keyset_id = keysetId;
				return this._keys.get(keysetId) as MintKeys;
			}
			const allKeysets = await this.mint.getKeys(keysetId)
			const keyset = allKeysets.keysets[0];
			if (!keyset) {
				throw new Error(`could not initialize keys. No keyset with id '${keysetId}' found`);
			}
			this._keys.set(keysetId, keyset);
			this._keyset_id = keysetId;
			return keyset;
		}

		// no keysetId was set, so we get the active keyset with the unit of the wallet with the lowest fees
		const allKeysets = await this.mint.getKeySets();
		const keysetToActivate = allKeysets.keysets
			.filter((k) => k.unit === this._unit && k.active)
			.sort((a, b) => (a.input_fees_ppk ?? 0) - (b.input_fees_ppk ?? 0))[0];
		if (!keysetToActivate) {
			throw new Error(`could not initialize keys. No active keyset with unit '${this._unit}' found`);
		}

		if (!this._keys.get(keysetToActivate.id)) {
			const keysetGet = await this.mint.getKeys(keysetToActivate.id);
			const keys = keysetGet.keysets.find((k) => k.id === keysetToActivate.id);
			if (!keys) {
				throw new Error(`could not initialize keys. No keyset with id '${keysetToActivate.id}' found`);
			}
			this._keys.set(keys.id, keys);
		}
		this._keyset_id = keysetToActivate.id;
		return this._keys.get(keysetToActivate.id) as MintKeys;
	}

	/**
	 * Receive an encoded or raw Cashu token (only supports single tokens. It will only process the first token in the token array)
	 * @param {(string|Token)} token - Cashu token
	 * @param preference optional preference for splitting proofs into specific amounts
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param pubkey? optionally locks ecash to pubkey. Will not be deterministic, even if counter is set!
	 * @param privkey? will create a signature on the @param token secrets if set
	 * @returns New token with newly created proofs, token entries that had errors
	 */
	async receive(
		token: string | Token,
		options?: {
			keysetId?: string;
			preference?: Array<AmountPreference>;
			counter?: number;
			pubkey?: string;
			privkey?: string;
		}
	): Promise<Array<Proof>> {
		try {
			if (typeof token === 'string') {
				token = getDecodedToken(token);
			}
			const tokenEntries: Array<TokenEntry> = token.token;
			const proofs = await this.receiveTokenEntry(tokenEntries[0], {
				keysetId: options?.keysetId,
				preference: options?.preference,
				counter: options?.counter,
				pubkey: options?.pubkey,
				privkey: options?.privkey
			});
			return proofs;
		} catch (error) {
			throw new Error('Error when receiving');
		}
	}

	/**
	 * Receive a single cashu token entry
	 * @param tokenEntry a single entry of a cashu token
	 * @param preference optional preference for splitting proofs into specific amounts.
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param pubkey? optionally locks ecash to pubkey. Will not be deterministic, even if counter is set!
	 * @param privkey? will create a signature on the @param tokenEntry secrets if set
	 * @returns New token entry with newly created proofs, proofs that had errors
	 */
	async receiveTokenEntry(
		tokenEntry: TokenEntry,
		options?: {
			keysetId?: string;
			preference?: Array<AmountPreference>;
			counter?: number;
			pubkey?: string;
			privkey?: string;
		}
	): Promise<Array<Proof>> {
		const proofs: Array<Proof> = [];
		try {
			const amount = tokenEntry.proofs.reduce((total, curr) => total + curr.amount, 0);
			let preference = options?.preference;
			if (!preference) {
				preference = getDefaultAmountPreference(amount);
			}
			const keys = await this.getKeys(options?.keysetId);
			const { payload, blindedMessages } = this.createSwapPayload(
				amount,
				tokenEntry.proofs,
				keys,
				preference,
				options?.counter,
				options?.pubkey,
				options?.privkey
			);
			const { signatures } = await CashuMint.split(tokenEntry.mint, payload);
			const newProofs = this.constructProofs(
				signatures,
				blindedMessages.rs,
				blindedMessages.secrets,
				keys
			);
			proofs.push(...newProofs);
		} catch (error) {
			throw new Error('Error receiving token entry');
		}
		return proofs;
	}

	/**
	 * Splits and creates sendable tokens
	 * if no amount is specified, the amount is implied by the cumulative amount of all proofs
	 * if both amount and preference are set, but the preference cannot fulfill the amount, then we use the default split
	 * @param amount amount to send while performing the optimal split (least proofs possible). can be set to undefined if preference is set
	 * @param proofs proofs matching that amount
	 * @param preference optional preference for splitting proofs into specific amounts. overrides amount param
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param pubkey? optionally locks ecash to pubkey. Will not be deterministic, even if counter is set!
	 * @param privkey? will create a signature on the @param proofs secrets if set
	 * @returns promise of the change- and send-proofs
	 */
	async send(
		amount: number,
		proofs: Array<Proof>,
		options?: {
			preference?: Array<AmountPreference>;
			counter?: number;
			pubkey?: string;
			privkey?: string;
			keysetId?: string;
		}
	): Promise<SendResponse> {
		if (options?.preference) {
			amount = options?.preference?.reduce((acc, curr) => acc + curr.amount * curr.count, 0);
		}
		const keyset = await this.getKeys(options?.keysetId);
		let amountAvailable = 0;
		const proofsToSend: Array<Proof> = [];
		const proofsToKeep: Array<Proof> = [];
		proofs.forEach((proof) => {
			if (amountAvailable >= amount) {
				proofsToKeep.push(proof);
				return;
			}
			amountAvailable = amountAvailable + proof.amount;
			proofsToSend.push(proof);
		});

		if (amount > amountAvailable) {
			throw new Error('Not enough funds available');
		}
		if (amount < amountAvailable || options?.preference || options?.pubkey) {
			const { amountKeep, amountSend } = this.splitReceive(amount, amountAvailable);
			const { payload, blindedMessages } = this.createSwapPayload(
				amountSend,
				proofsToSend,
				keyset,
				options?.preference,
				options?.counter,
				options?.pubkey,
				options?.privkey
			);
			const { signatures } = await this.mint.split(payload);
			const proofs = this.constructProofs(
				signatures,
				blindedMessages.rs,
				blindedMessages.secrets,
				keyset
			);
			// sum up proofs until amount2 is reached
			const splitProofsToKeep: Array<Proof> = [];
			const splitProofsToSend: Array<Proof> = [];
			let amountKeepCounter = 0;
			proofs.forEach((proof) => {
				if (amountKeepCounter < amountKeep) {
					amountKeepCounter += proof.amount;
					splitProofsToKeep.push(proof);
					return;
				}
				splitProofsToSend.push(proof);
			});
			return {
				returnChange: [...splitProofsToKeep, ...proofsToKeep],
				send: splitProofsToSend
			};
		}
		return { returnChange: proofsToKeep, send: proofsToSend };
	}

	/**
	 * Regenerates
	 * @param start set starting point for count (first cycle for each keyset should usually be 0)
	 * @param count set number of blinded messages that should be generated
	 * @returns proofs
	 */
	async restore(
		start: number,
		count: number,
		options?: {
			keysetId?: string;
		}
	): Promise<{ proofs: Array<Proof> }> {
		const keys = await this.getKeys(options?.keysetId);
		if (!this._seed) {
			throw new Error('CashuWallet must be initialized with mnemonic to use restore');
		}
		// create blank amounts for unknown restore amounts
		const amounts = Array(count).fill(0);
		const { blindedMessages, rs, secrets } = this.createBlindedMessages(amounts, keys.id, start);

		const { outputs, promises } = await this.mint.restore({ outputs: blindedMessages });

		// Collect and map the secrets and blinding factors with the blinded messages that were returned from the mint
		const validRs = rs.filter((r, i) => outputs.map((o) => o.B_).includes(blindedMessages[i].B_));
		const validSecrets = secrets.filter((s, i) =>
			outputs.map((o) => o.B_).includes(blindedMessages[i].B_)
		);

		return {
			proofs: this.constructProofs(promises, validRs, validSecrets, keys)
		};
	}

	/**
	 * Requests a mint quote form the mint. Response returns a Lightning payment request for the requested given amount and unit.
	 * @param amount Amount requesting for mint.
	 * @returns the mint will return a mint quote with a Lightning invoice for minting tokens of the specified amount and unit
	 */
	async createMintQuote(amount: number) {
		const mintQuotePayload: MintQuotePayload = {
			unit: this._unit,
			amount: amount
		};
		return await this.mint.createMintQuote(mintQuotePayload);
	}

	/**
	 * Gets an existing mint quote from the mint.
	 * @param quote Quote ID
	 * @returns the mint will create and return a Lightning invoice for the specified amount
	 */
	async checkMintQuote(quote: string) {
		return await this.mint.checkMintQuote(quote);
	}

	/**
	 * Mint tokens for a given mint quote
	 * @param amount amount to request
	 * @param quote ID of mint quote
	 * @returns proofs
	 */
	async mintTokens(
		amount: number,
		quote: string,
		options?: {
			keysetId?: string;
			preference?: Array<AmountPreference>;
			counter?: number;
			pubkey?: string;
		}
	): Promise<{ proofs: Array<Proof> }> {
		const keyset = await this.getKeys(options?.keysetId);
		const { blindedMessages, secrets, rs } = this.createRandomBlindedMessages(
			amount,
			options?.keysetId ?? keyset.id,
			options?.preference,
			options?.counter,
			options?.pubkey
		);
		const mintPayload: MintPayload = {
			outputs: blindedMessages,
			quote: quote
		};
		const { signatures } = await this.mint.mint(mintPayload);
		return {
			proofs: this.constructProofs(signatures, rs, secrets, keyset)
		};
	}

	/**
	 * Requests a melt quote from the mint. Response returns amount and fees for a given unit in order to pay a Lightning invoice.
	 * @param invoice LN invoice that needs to get a fee estimate
	 * @returns the mint will create and return a melt quote for the invoice with an amount and fee reserve
	 */
	async createMeltQuote(invoice: string): Promise<MeltQuoteResponse> {
		const meltQuotePayload: MeltQuotePayload = {
			unit: this._unit,
			request: invoice
		};
		const meltQuote = await this.mint.createMeltQuote(meltQuotePayload);
		return meltQuote;
	}

	/**
	 * Return an existing melt quote from the mint.
	 * @param quote ID of the melt quote
	 * @returns the mint will return an existing melt quote
	 */
	async checkMeltQuote(quote: string): Promise<MeltQuoteResponse> {
		const meltQuote = await this.mint.checkMeltQuote(quote);
		return meltQuote;
	}

	/**
	 * Melt tokens for a melt quote. proofsToSend must be at least amount+fee_reserve form the melt quote.
	 * Returns payment proof and change proofs
	 * @param meltQuote ID of the melt quote
	 * @param proofsToSend proofs to melt
	 * @param options.keysetId? optionally set keysetId for blank outputs for returned change.
	 * @param options.counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns
	 */
	async meltTokens(
		meltQuote: MeltQuoteResponse,
		proofsToSend: Array<Proof>,
		options?: {
			keysetId?: string;
			counter?: number;
		}
	): Promise<MeltTokensResponse> {
		const keys = await this.getKeys(options?.keysetId);

		const { blindedMessages, secrets, rs } = this.createBlankOutputs(
			meltQuote.fee_reserve,
			keys.id,
			options?.counter
		);
		const meltPayload: MeltPayload = {
			quote: meltQuote.quote,
			inputs: proofsToSend,
			outputs: [...blindedMessages]
		};
		const meltResponse = await this.mint.melt(meltPayload);

		return {
			isPaid: meltResponse.state === MeltQuoteState.PAID,
			preimage: meltResponse.payment_preimage,
			change: meltResponse?.change
				? this.constructProofs(meltResponse.change, rs, secrets, keys)
				: []
		};
	}

	/**
	 * Helper function that pays a Lightning invoice directly without having to create a melt quote before
	 * The combined amount of Proofs must match the payment amount including fees.
	 * @param invoice
	 * @param proofsToSend the exact amount to send including fees
	 * @param meltQuote melt quote for the invoice
	 * @param options.keysetId? optionally set keysetId for blank outputs for returned change.
	 * @param options.counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns
	 */
	async payLnInvoice(
		invoice: string,
		proofsToSend: Array<Proof>,
		meltQuote?: MeltQuoteResponse,
		options?: {
			keysetId?: string;
			counter?: number;
		}
	): Promise<MeltTokensResponse> {
		if (!meltQuote) {
			meltQuote = await this.mint.createMeltQuote({ unit: this._unit, request: invoice });
		}
		return await this.meltTokens(meltQuote, proofsToSend, {
			keysetId: options?.keysetId,
			counter: options?.counter
		});
	}

	/**
	 * Helper function to ingest a Cashu token and pay a Lightning invoice with it.
	 * @param invoice Lightning invoice
	 * @param token cashu token
	 * @param meltQuote melt quote for the invoice
	 * @param options.keysetId? optionally set keysetId for blank outputs for returned change.
	 * @param options.counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 */
	async payLnInvoiceWithToken(
		invoice: string,
		token: string,
		meltQuote: MeltQuoteResponse,
		options?: {
			keysetId?: string;
			counter?: number;
		}
	): Promise<MeltTokensResponse> {
		const decodedToken = getDecodedToken(token);
		const proofs = decodedToken.token
			.filter((x) => x.mint === this.mint.mintUrl)
			.flatMap((t) => t.proofs);
		return this.payLnInvoice(invoice, proofs, meltQuote, {
			keysetId: options?.keysetId,
			counter: options?.counter
		});
	}

	/**
	 * Creates a split payload
	 * @param amount amount to send
	 * @param proofsToSend proofs to split*
	 * @param preference optional preference for splitting proofs into specific amounts. overrides amount param
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param pubkey? optionally locks ecash to pubkey. Will not be deterministic, even if counter is set!
	 * @param privkey? will create a signature on the @param proofsToSend secrets if set
	 * @returns
	 */
	private createSwapPayload(
		amount: number,
		proofsToSend: Array<Proof>,
		keyset: MintKeys,
		preference?: Array<AmountPreference>,
		counter?: number,
		pubkey?: string,
		privkey?: string
	): {
		payload: SwapPayload;
		blindedMessages: BlindedTransaction;
	} {
		const totalAmount = proofsToSend.reduce((total, curr) => total + curr.amount, 0);
		const keepBlindedMessages = this.createRandomBlindedMessages(
			totalAmount - amount,
			keyset.id,
			undefined,
			counter
		);
		if (this._seed && counter) {
			counter = counter + keepBlindedMessages.secrets.length;
		}
		const sendBlindedMessages = this.createRandomBlindedMessages(
			amount,
			keyset.id,
			preference,
			counter,
			pubkey
		);
		if (privkey) {
			proofsToSend = getSignedProofs(
				proofsToSend.map((p) => {
					return {
						amount: p.amount,
						C: pointFromHex(p.C),
						id: p.id,
						secret: new TextEncoder().encode(p.secret)
					};
				}),
				privkey
			).map((p: NUT11Proof) => serializeProof(p));
		}

		// join keepBlindedMessages and sendBlindedMessages
		const blindedMessages: BlindedTransaction = {
			blindedMessages: [
				...keepBlindedMessages.blindedMessages,
				...sendBlindedMessages.blindedMessages
			],
			secrets: [...keepBlindedMessages.secrets, ...sendBlindedMessages.secrets],
			rs: [...keepBlindedMessages.rs, ...sendBlindedMessages.rs],
			amounts: [...keepBlindedMessages.amounts, ...sendBlindedMessages.amounts]
		};

		const payload = {
			inputs: proofsToSend,
			outputs: [...blindedMessages.blindedMessages]
		};
		return { payload, blindedMessages };
	}
	/**
	 * returns proofs that are already spent (use for keeping wallet state clean)
	 * @param proofs (only the 'Y' field is required)
	 * @returns
	 */
	async checkProofsSpent<T extends { secret: string }>(proofs: Array<T>): Promise<Array<T>> {
		const enc = new TextEncoder();
		const Ys = proofs.map((p) => hashToCurve(enc.encode(p.secret)).toHex(true));
		const payload = {
			// array of Ys of proofs to check
			Ys: Ys
		};
		const { states } = await this.mint.check(payload);

		return proofs.filter((_, i) => {
			const state = states.find((state) => state.Y === Ys[i]);
			return state && state.state === CheckStateEnum.SPENT;
		});
	}
	private splitReceive(
		amount: number,
		amountAvailable: number
	): { amountKeep: number; amountSend: number } {
		const amountKeep: number = amountAvailable - amount;
		const amountSend: number = amount;
		return { amountKeep, amountSend };
	}

	/**
	 * Creates blinded messages for a given amount
	 * @param amount amount to create blinded messages for
	 * @param amountPreference optional preference for splitting proofs into specific amounts. overrides amount param
	 * @param keyksetId? override the keysetId derived from the current mintKeys with a custom one. This should be a keyset that was fetched from the `/keysets` endpoint
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param pubkey? optionally locks ecash to pubkey. Will not be deterministic, even if counter is set!
	 * @returns blinded messages, secrets, rs, and amounts
	 */
	private createRandomBlindedMessages(
		amount: number,
		keysetId: string,
		amountPreference?: Array<AmountPreference>,
		counter?: number,
		pubkey?: string
	): BlindedMessageData & { amounts: Array<number> } {
		const amounts = splitAmount(amount, amountPreference);
		return this.createBlindedMessages(amounts, keysetId, counter, pubkey);
	}

	/**
	 * Creates blinded messages for a according to @param amounts
	 * @param amount array of amounts to create blinded messages for
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param keyksetId? override the keysetId derived from the current mintKeys with a custom one. This should be a keyset that was fetched from the `/keysets` endpoint
	 * @param pubkey? optionally locks ecash to pubkey. Will not be deterministic, even if counter is set!
	 * @returns blinded messages, secrets, rs, and amounts
	 */
	private createBlindedMessages(
		amounts: Array<number>,
		keysetId: string,
		counter?: number,
		pubkey?: string
	): BlindedMessageData & { amounts: Array<number> } {
		// if we atempt to create deterministic messages without a _seed, abort.
		if (counter != undefined && !this._seed) {
			throw new Error(
				'Cannot create deterministic messages without seed. Instantiate CashuWallet with a mnemonic, or omit counter param.'
			);
		}
		const blindedMessages: Array<SerializedBlindedMessage> = [];
		const secrets: Array<Uint8Array> = [];
		const rs: Array<bigint> = [];
		for (let i = 0; i < amounts.length; i++) {
			let deterministicR = undefined;
			let secretBytes = undefined;
			if (pubkey) {
				secretBytes = createP2PKsecret(pubkey);
			} else if (this._seed && counter != undefined) {
				secretBytes = deriveSecret(this._seed, keysetId, counter + i);
				deterministicR = bytesToNumber(deriveBlindingFactor(this._seed, keysetId, counter + i));
			} else {
				secretBytes = randomBytes(32);
			}
			if (!pubkey) {
				const secretHex = bytesToHex(secretBytes);
				secretBytes = new TextEncoder().encode(secretHex);
			}
			secrets.push(secretBytes);
			const { B_, r } = blindMessage(secretBytes, deterministicR);
			rs.push(r);
			const blindedMessage = new BlindedMessage(amounts[i], B_, keysetId);
			blindedMessages.push(blindedMessage.getSerializedBlindedMessage());
		}
		return { blindedMessages, secrets, rs, amounts };
	}

	/**
	 * Creates NUT-08 blank outputs (fee returns) for a given fee reserve
	 * See: https://github.com/cashubtc/nuts/blob/main/08.md
	 * @param feeReserve amount to cover with blank outputs
	 * @param keysetId mint keysetId
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns blinded messages, secrets, and rs
	 */
	private createBlankOutputs(
		feeReserve: number,
		keysetId: string,
		counter?: number
	): BlindedMessageData {
		let count = Math.ceil(Math.log2(feeReserve)) || 1;
		//Prevent count from being -Infinity
		if (count < 0) {
			count = 0;
		}
		const amounts = count ? Array(count).fill(1) : [];
		const { blindedMessages, rs, secrets } = this.createBlindedMessages(amounts, keysetId, counter);
		return { blindedMessages, secrets, rs };
	}

	/**
	 * construct proofs from @params promises, @params rs, @params secrets, and @params keyset
	 * @param promises array of serialized blinded signatures
	 * @param rs arrays of binding factors
	 * @param secrets array of secrets
	 * @param keyset mint keyset
	 * @returns array of serialized proofs
	 */
	private constructProofs(
		promises: Array<SerializedBlindedSignature>,
		rs: Array<bigint>,
		secrets: Array<Uint8Array>,
		keyset: MintKeys
	): Array<Proof> {
		return promises
			.map((p: SerializedBlindedSignature, i: number) => {
				const blindSignature = { id: p.id, amount: p.amount, C_: pointFromHex(p.C_) };
				const r = rs[i];
				const secret = secrets[i];
				const A = pointFromHex(keyset.keys[p.amount]);
				return constructProofFromPromise(blindSignature, r, secret, A);
			})
			.map((p) => serializeProof(p) as Proof);
	}
}

export { CashuWallet };
