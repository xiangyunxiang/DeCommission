import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import taskAbi from './contract/TaskPlatform.json'
import { Wallet, PlusCircle, CheckCircle } from 'lucide-react'

const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

function App() {
  const [account, setAccount] = useState(null)
  const [contract, setContract] = useState(null)
  const [tasks, setTasks] = useState([])
  const [desc, setDesc] = useState("")

  // 1. Connect to MetaMask and initialize contract
  const connectWallet = async () => {
    if (!window.ethereum) return alert("Please install MetaMask");
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const platformContract = new ethers.Contract(CONTRACT_ADDRESS, taskAbi.abi, signer);
    
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    setAccount(accounts[0]);
    setContract(platformContract);
    loadTasks(platformContract);
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
    </div>
  )
}

export default App