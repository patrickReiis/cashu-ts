# Cashu JS

⚠️ __Don't be reckless:__ This project is in early development, it does however work with real sats! Always use amounts you don't mind loosing.

Cashu JS is a JavaScript library for [Cashu](https://cashu.space) wallets written in Typescript.

Wallet Features:

- [x] connect to mint (load keys)
- [x] request minting tokens
- [x] minting tokens
- [x] sending tokens (get encoded token for chosen value)
- [x] receiving tokens
- [x] melting tokens
- [ ] ...

## Usage

### Install

```shell
npm i @gandlaf21/cashu-js
```

### Import

```javascript
import { CashuMint, CashuWallet } from "@gandlaf21/cashu-js";

const mint = new CashuMint("{MINT_HOST}","{/path/to/api/root/}, {MINT_PORT}")
const keys = await mint.getKeys()
const wallet = new CashuWallet(keys,mint)

const {pr, hash} = await wallet.requestMint(200)

//pay this LN invoice
console.log(pr)

async function invoiceHasBeenPaid() {
const proofs = await wallet.requestTokens(200,hash)
//Encoded proofs can be spent at the mint
const encoded = wallet.getEncodedProofs(proofs)
console.log(encoded)
}

```

## Contribute

Contributions are very welcome.

If you want to contribute, please open an Issue or a PR. 