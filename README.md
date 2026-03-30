# DeCommission: Simple Blockchain Task Marketplace

A decentralized task-matching platform about digital art commission, where clients can post tasks with ETH rewards, and artists can claim and complete them. This project is a full-stack DApp consisting of a **Solidity** smart contract backend and a **React** frontend.

## 🏗 Project Structure

| Folder | Technology | Description |
| :--- | :--- | :--- |
| `backend/` | Solidity, Hardhat | Smart contract, deployment scripts, and unit tests. |
| `frontend/` | React, Vite, Ethers.js | Web interface to interact with the blockchain. |

-----

## 🛠 Prerequisites

Before you begin, ensure you have the following installed:

1.  **Node.js** (v18.0.0 or higher)
2.  **MetaMask Extension**: Download and install for your browser (Chrome/Brave/Edge).

-----

## 🚀 Getting Started

Follow these steps to get the project running locally.

### 1\. Backend Setup (The Local Blockchain)

Open a terminal and navigate to the backend folder:

```bash
cd backend
npm install
```

**Launch the local blockchain node:**

```bash
npx hardhat node
```

*Note: Keep this terminal open\! It provides 20 test accounts with 10,000 fake ETH each. Copy the **Private Key** of Account \#0 and Account \#1 for later.*

**Deploy the Smart Contract:**
Open a **new** terminal in the `backend` folder:

```bash
npx hardhat run scripts/deploy.js --network localhost
```

*Copy the **Deployed Address** printed in the terminal. You will need it for the frontend.*

-----

### 2\. Frontend Setup

Navigate to the frontend folder:

```bash
cd ../frontend
npm install
```

**Configure the Contract Address:**

1.  Open `src/App.jsx`.
2.  Locate the variable `CONTRACT_ADDRESS` at the top.
3.  Replace the placeholder with the address you copied during the deployment step.

**Run the Development Server:**

```bash
npm run dev
```

Open [http://localhost:5173](https://www.google.com/search?q=http://localhost:5173) in your browser.

-----

## 🦊 MetaMask Configuration (Important\!)

Since we are running a local blockchain, you need to point MetaMask to it.

### A. Add the Hardhat Network

1.  Open MetaMask -\> Click the **Network Selection** dropdown (top left).
2.  Click **Add Network** -\> **Add a network manually**.
3.  Fill in:
      - **Network Name**: Hardhat Local
      - **New RPC URL**: `http://127.0.0.1:8545`
      - **Chain ID**: `31337`
      - **Currency Symbol**: `ETH`
4.  Save and switch to this network.

### B. Import Test Accounts

1.  Click the **Account Icon** (circle) -\> **Import Account**.
2.  Paste the **Private Key** of Account \#0 (from your `hardhat node` terminal).
3.  Repeat for Account \#1 to simulate having two different users (Employer and Worker).

-----

## 🧪 Testing the Workflow

1.  **Connect**: Click "Connect MetaMask" on the website using **Account \#0**.
2.  **Post**: Write a description and click "Post Task". Confirm the transaction in MetaMask (costs 1 ETH).
3.  **Switch**: In MetaMask, switch to **Account \#1**.
4.  **Claim**: Click "Claim Task" on the task you just created.
5.  **Pay**: Switch back to **Account \#0** (Employer) and click "Confirm Completion & Pay".
6.  **Verify**: Check the balance of Account \#1—it should have increased by 1 ETH\!

-----

## ⚠️ Troubleshooting

  - **Nonce Issue**: If you restart the `hardhat node`, MetaMask might get confused by old transaction history.
      - **Fix**: Go to MetaMask -\> Settings -\> Advanced -\> **Clear activity tab data** (or Reset Account).
  - **Contract not found**: Ensure the `CONTRACT_ADDRESS` in `App.jsx` matches the one from your latest deployment.

-----

### 💡 Next Steps for Teammates

  - Explore `backend/contracts/TaskPlatform.sol` to see the logic.
  - Run `npx hardhat test` in the `backend` folder to see the automated test suite.

-----

**Would you like me to also generate a short "How to Contribute" section or a guide on how to add new features to this project?**


Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (10000 ETH)
Private Key: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

Account #2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC (10000 ETH)
Private Key: 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

Account #3: 0x90F79bf6EB2c4f870365E785982E1f101E93b906 (10000 ETH)
Private Key: 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

Account #4: 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 (10000 ETH)
Private Key: 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a

Account #5: 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc (10000 ETH)
Private Key: 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba

Account #6: 0x976EA74026E726554dB657fA54763abd0C3a0aa9 (10000 ETH)
Private Key: 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e

Account #7: 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 (10000 ETH)
Private Key: 0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356

Account #8: 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f (10000 ETH)
Private Key: 0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97

Account #9: 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 (10000 ETH)
Private Key: 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6

Account #10: 0xBcd4042DE499D14e55001CcbB24a551F3b954096 (10000 ETH)
Private Key: 0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897

Account #11: 0x71bE63f3384f5fb98995898A86B02Fb2426c5788 (10000 ETH)
Private Key: 0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82

Account #12: 0xFABB0ac9d68B0B445fB7357272Ff202C5651694a (10000 ETH)
Private Key: 0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1

Account #13: 0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec (10000 ETH)
Private Key: 0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd

Account #14: 0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097 (10000 ETH)
Private Key: 0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa

Account #15: 0xcd3B766CCDd6AE721141F452C550Ca635964ce71 (10000 ETH)
Private Key: 0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61

Account #16: 0x2546BcD3c84621e976D8185a91A922aE77ECEc30 (10000 ETH)
Private Key: 0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0

Account #17: 0xbDA5747bFD65F08deb54cb465eB87D40e51B197E (10000 ETH)
Private Key: 0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd

Account #18: 0xdD2FD4581271e230360230F9337D5c0430Bf44C0 (10000 ETH)
Private Key: 0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0

Account #19: 0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199 (10000 ETH)
Private Key: 0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e