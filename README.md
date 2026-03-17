# DeCommission: Simple Blockchain Task Marketplace

A decentralized task-matching platform where employers can post tasks with ETH rewards, and workers can claim and complete them. This project is a full-stack DApp consisting of a **Solidity** smart contract backend and a **React** frontend.

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