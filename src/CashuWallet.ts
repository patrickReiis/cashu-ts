import { CashuMint } from "./CashuMint";
import * as utils from "./utils";
import { utils as ecUtils } from "@noble/secp256k1";
import * as dhke from "./DHKE";
import { encodeBase64ToJson, encodeJsonToBase64 } from "./base64";
import { Proof } from "./model/Proof";
import { BlindedMessage } from "./model/BlindedMessage";

class CashuWallet {
    keys: object
    mint: CashuMint
    constructor(keys: object, mint: CashuMint) {
        this.keys = keys
        this.mint = mint
    }

    async requestMint(amount: number) {
        return await this.mint.requestMint(amount)
    }

    // todo: get amount from invoice
    async payLnInvoice(amount:number, invoice:string, proofs: Array<Proof>){
        const {fee}: {fee:number} = await this.mint.checkFees({pr: invoice}).catch((e)=>{
            console.error(e)
            console.error('could not get fees from server')
            return {fee: 0}
        })
        console.log(isNaN(fee))
        //todo: add fee to amount
        const amountToPay: number = amount
        const allProofsEncoded = await this.send(amountToPay, proofs)
        const proofsToSend: Array<Proof> = encodeBase64ToJson(allProofsEncoded[1])
        const paymentPayload: any = this.createPaymentPayload(invoice,proofsToSend)
        const payData = await this.mint.melt(paymentPayload)
        return {isPaid: payData.paid, preimage: payData.preimage, change: allProofsEncoded[0]}
    }

    createPaymentPayload(invoice:string, proofs: Array<Proof>){
        const payload = {
            invoice: invoice,
            proofs: proofs
        }
        return payload
    }

    async payLnInvoiceWithToken(amount:number, invoice:string, token: string){
        return this.payLnInvoice(amount, invoice, encodeBase64ToJson(token))
    }

    async recieve(encodedToken: string): Promise<string> {
        const proofs: Array<Proof> = encodeBase64ToJson(encodedToken)
        const amount = proofs.reduce((total,curr)=>{
            return total+curr.amount
        },0)
        const {payload,amount1BlindedMessages, amount2BlindedMessages} = await this.createSplitPayload(0,amount,proofs)
        const {fst,snd} = await this.mint.split(payload)
        const proofs1: Array<Proof> = dhke.constructProofs(fst,amount1BlindedMessages.rs,amount1BlindedMessages.secrets,this.keys)
        const proofs2: Array<Proof> = dhke.constructProofs(snd,amount2BlindedMessages.rs, amount2BlindedMessages.secrets, this.keys)
        const newProofs: Array<Proof> = [...proofs1]
        newProofs.push(...proofs2)
        return this.getEncodedProofs(newProofs)
    }

    //Todo, fix splitting of funds, something is not right yet
    async send(amount: number, proofs: Array<Proof>): Promise<Array<string>> {
        let amountAvailable = 0
        const proofsToSend: Array<Proof> = []
        proofs.forEach(proof => {
            if (amountAvailable >= amount) {
                return
            }
            amountAvailable = amountAvailable + proof.amount
            proofsToSend.push(proof)
        });
        console.log(`amount: ${amount} ||| amount available: ${amountAvailable}`)
        if (amount > amountAvailable) {
            throw new Error("Not enough funds available");
        }
        if (amount < amountAvailable) {
            const { amount1, amount2 } = this.splitReceive(amount, amountAvailable)
            const {payload, amount1BlindedMessages, amount2BlindedMessages} =await  this.createSplitPayload(amount1, amount2, proofsToSend)
            const {fst, snd} = await this.mint.split(payload)
            const proofs1 = dhke.constructProofs(fst,amount1BlindedMessages.rs,amount1BlindedMessages.secrets,this.keys)
            const proofs2 = dhke.constructProofs(snd,amount2BlindedMessages.rs,amount2BlindedMessages.secrets,this.keys)
            return [this.getEncodedProofs(proofs1), this.getEncodedProofs(proofs2)]
        }
        return ['',this.getEncodedProofs(proofsToSend)]
    }

    getEncodedProofs(proofs: Array<Proof>): string {
        return encodeJsonToBase64(proofs)
    }

    async requestTokens(amount: number, hash: string): Promise<Array<Proof>> {
        const { blindedMessages, secrets, rs } = await this.createRandomBlindedMessages(amount)
        const payloads: { blinded_messages: Array<{ amount: number, B_: string }> } = { blinded_messages: blindedMessages }
        const payloadsJson = JSON.parse(JSON.stringify({ payloads }, utils.bigIntStringify))
        const promises = await this.mint.mint(payloadsJson.payloads, hash)
        if (promises.error) {
            throw new Error(promises.error)
        }
        return dhke.constructProofs(promises, rs, secrets, this.keys)
    }


    //keep amount 1 send amount 2
    private async createSplitPayload(amount1:number, amount2: number, proofsToSend: Array<Proof>) {
        const amount1BlindedMessages = await this.createRandomBlindedMessages(amount1)
        const amount2BlindedMessages = await this.createRandomBlindedMessages(amount2)
        const allBlindedMessages = []
        // the order of this array aparently matters if it's the other way around,
        // the mint complains that the split is not as expected
        allBlindedMessages.push(...amount1BlindedMessages.blindedMessages)
        allBlindedMessages.push(...amount2BlindedMessages.blindedMessages)

            const payload = { 
                proofs: proofsToSend,
                amount: amount2,
                outputs: { 
                    blinded_messages: allBlindedMessages
                } 
            }
        return {payload, amount1BlindedMessages, amount2BlindedMessages}
    }
    //keep amount 1 send amount 2
    private splitReceive(amount: number, amountAvailable: number) {
        const amount1: number = amountAvailable - amount
        const amount2: number = amount
        return { amount1, amount2 }
    }


 
    private async createRandomBlindedMessages(amount: number) {
        const blindedMessages: Array<{ amount: number, B_: string }> = []
        const secrets: Array<Uint8Array> = []
        const rs: Array<bigint> = []
        const amounts: Array<number> = utils.splitAmount(amount)
        for (let i = 0; i < amounts.length; i++) {
            const secret: Uint8Array = ecUtils.randomBytes(32)
            secrets.push(secret)
            const { B_, r } = await dhke.blindMessage(secret)
            rs.push(r)
            const blindedMessage: BlindedMessage = new BlindedMessage(amounts[i], B_)
            blindedMessages.push(blindedMessage.getSerealizedBlindedMessage())
        }
        return { blindedMessages, secrets, rs, amounts }
    }
}

export { CashuWallet }