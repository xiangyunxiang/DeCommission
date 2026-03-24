import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import taskAbi from './contract/TaskPlatform.json'
import dataFetcherAbi from './contract/DataFetcher.json'
import { Wallet, PlusCircle, CheckCircle } from 'lucide-react'

const TASK_CONTRACT_ADDRESS = "0x9A676e781A523b5d0C0e43731313A708CB607508"
const DATA_FETCHER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" // Update with actual deployed address

function App() {
  const [account, setAccount] = useState(null)
  const [contract, setContract] = useState(null)
  const [dataFetcherContract, setDataFetcherContract] = useState(null)
  const [tasks, setTasks] = useState([])
  const [storefront, setStorefront] = useState([])
  const [desc, setDesc] = useState("")

  // 1. Connect to MetaMask and initialize contracts
  const connectWallet = async () => {
    if (!window.ethereum) return alert("Please install MetaMask");
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const platformContract = new ethers.Contract(TASK_CONTRACT_ADDRESS, taskAbi.abi, signer);
    const dataFetcher = new ethers.Contract(DATA_FETCHER_ADDRESS, dataFetcherAbi.abi, provider);
    
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    setAccount(accounts[0]);
    setContract(platformContract);
    setDataFetcherContract(dataFetcher);
    loadTasks(platformContract);
    loadStorefront(dataFetcher);
  }

  // 2. Load tasks from the contract
  const loadTasks = async (platformContract) => {
    const count = await platformContract.taskCount();
    let tempTasks = [];
    for (let i = 1; i <= count; i++) {
      const t = await platformContract.tasks(i);
      tempTasks.push(t);
    }
    setTasks(tempTasks);
  }

  // 2.5 Load storefront products from DataFetcher
  const loadStorefront = async (dataFetcher) => {
    try {
      const products = await dataFetcher.getStorefront();
      setStorefront(products);
    } catch (error) {
      console.error("Error loading storefront:", error);
    }
  }

  // 3. Create a new task (employer posts a task with a reward of 1 ETH)
  const createTask = async () => {
    if (!contract || !desc) return;
    const tx = await contract.createTask(desc, { value: ethers.parseEther("1.0") });
    await tx.wait(); // 等待交易打包
    alert("Task Created!");
    loadTasks(contract);
  }

  // 4. Claim a task (worker claims an open task)
  const claimTask = async (id) => {
    const tx = await contract.claimTask(id);
    await tx.wait();
    loadTasks(contract);
  }

  // 5. Complete a task (employer confirms completion and pays the worker)
  const completeTask = async (id) => {
    const tx = await contract.completeTask(id);
    await tx.wait();
    loadTasks(contract);
  }

  return (
    <div style={{ maxWidth: '800px', margin: '40px auto', fontFamily: 'Arial' }}>
      <h1>Blockchain Marketplace</h1>
      {!account ? (
        <button onClick={connectWallet}>Connect MetaMask</button>
      ) : (
        <div>
          <p>User: {account}</p>
          <div style={{ background: '#f4f4f4', padding: '15px', borderRadius: '8px' }}>
            <input placeholder="Task description..." value={desc} onChange={e => setDesc(e.target.value)} />
            <button onClick={createTask}>Post Task (1 ETH)</button>
          </div>
        </div>
      )}

      <h2>Task List</h2>
      {tasks.map((t, index) => (
        <div key={index} style={{ border: '1px solid #ccc', padding: '10px', margin: '10px 0' }}>
          <p><strong>Desc:</strong> {t.description}</p>
          <p><strong>Reward:</strong> {ethers.formatEther(t.reward)} ETH</p>
          <p><strong>Status:</strong> {["Open", "Claimed", "Completed"][Number(t.status)]}</p>
          
          {t.status == 0 && account && t.employer.toLowerCase() !== account.toLowerCase() && (
            <button onClick={() => claimTask(t.id)}>Claim Task</button>
          )}
          {t.status == 1 && account && t.employer.toLowerCase() === account.toLowerCase() && (
            <button onClick={() => completeTask(t.id)}>Confirm Completion & Pay</button>
          )}
        </div>
      ))}

      <h2>Storefront - Listed Products</h2>
      {storefront && storefront.length > 0 ? (
        storefront.map((product, index) => (
          <div key={index} style={{ border: '1px solid #ddd', padding: '15px', margin: '10px 0', backgroundColor: '#f9f9f9' }}>
            <p><strong>Product ID:</strong> {product.id.toString()}</p>
            <p><strong>Seller:</strong> {product.seller}</p>
            <p><strong>Price:</strong> {ethers.formatEther(product.price)} ETH</p>
            <p><strong>IPFS Hash:</strong> {product.ipfsHash}</p>
            <p><strong>Status:</strong> {["Listed", "Sold", "Other"][Number(product.status)]}</p>
            {product.buyer !== "0x0000000000000000000000000000000000000000" && (
              <p><strong>Buyer:</strong> {product.buyer}</p>
            )}
          </div>
        ))
      ) : (
        <p>No products listed yet.</p>
      )}
    </div>
  )
}

export default App