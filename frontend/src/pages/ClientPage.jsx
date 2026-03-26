/**
 * ClientPage.jsx — DeCommission 买家下单页面
 *
 * 这个文件是"纯前端"：用户能看到的所有界面都在这里。
 * 它同时也是"翻译官"：当用户点击按钮，它会调用 Ethers.js 去和合约说话。
 *
 * 结构总览：
 *   1. import      — 引入需要的工具
 *   2. 常量配置    — 合约地址 & ABI
 *   3. 组件主体    — useState 管理状态，函数处理逻辑，return 返回界面
 */

// ─── 1. IMPORTS ───────────────────────────────────────────────────────────────
// React 核心：useState 用来记住数据，useEffect 用来在页面加载时自动做事情
import { useState, useEffect } from "react"

// Ethers.js：和以太坊区块链交互的工具库
// BrowserProvider = 通过 MetaMask 连接到链
// ethers.parseEther = 把"0.5"这种人类读的数字转成链上用的 wei 单位
// ethers.formatEther = 反过来，把 wei 转回 ETH 显示给用户看
import { ethers } from "ethers"

// ─── 2. 合约配置 ──────────────────────────────────────────────────────────────
// 部署合约后，终端会打印一个地址，粘贴到这里
const CONTRACT_ADDRESS = "0x你的合约地址粘贴在这里"

// ABI = 合约的"目录"，告诉前端合约有哪些函数可以调用
// 这段要从 backend/artifacts/contracts/CommissionEscrow.sol/CommissionEscrow.json
// 里找到 "abi" 那个数组，复制过来替换下面这个示例
const CONTRACT_ABI = [
  // 函数：Client 支付创建订单
  // inputs: listingId (uint256) = Artist 发布的listing编号
  // payable: 表示调用时要附带 ETH
  "function createOrder(uint256 listingId) payable",

  // 函数：Client 确认满意，释放资金给 Artist
  "function confirmCompletion(uint256 orderId)",

  // 函数：Client 发起争议
  // 调用时需要附带 Client 的押金
  "function raiseDispute(uint256 orderId) payable",

  // 读取函数：查看某个订单的详情（纯读取，不花 Gas）
  // returns: 一个包含订单所有信息的结构体
  "function orders(uint256) view returns (uint256 id, address client, address artist, uint256 amount, uint8 status)",

  // 读取函数：查看所有可接单的 listings
  "function getActiveListings() view returns (tuple(uint256 id, address artist, string description, uint256 price)[])",

  // 事件：订单创建成功时合约会发出这个信号
  // 前端可以监听它来自动刷新页面
  "event OrderCreated(uint256 indexed orderId, address indexed client, uint256 amount)",

  // 事件：订单完成
  "event OrderCompleted(uint256 indexed orderId)",
]

// ─── 3. 组件主体 ──────────────────────────────────────────────────────────────
export default function ClientPage() {

  // ── useState：记住页面需要的数据 ──────────────────────────────────────────
  // useState(初始值) 返回 [当前值, 修改这个值的函数]
  // 每次调用"修改函数"，React 会自动重新渲染页面

  const [account, setAccount]       = useState(null)    // 当前连接的钱包地址
  const [signer, setSigner]         = useState(null)    // Ethers.js 的签名对象（用来发交易）
  const [listings, setListings]     = useState([])      // 从合约读到的所有可接订单
  const [myOrders, setMyOrders]     = useState([])      // 我创建的订单列表
  const [loading, setLoading]       = useState(false)   // 是否正在等待交易确认
  const [txStatus, setTxStatus]     = useState("")      // 交易状态提示文字
  const [selectedListing, setSelectedListing] = useState(null) // 用户选中的 listing

  // 订单状态的中文映射（合约里是数字 0/1/2/3/4）
  const ORDER_STATUS = {
    0: "已支付",
    1: "已交付",
    2: "已完成",
    3: "争议中",
    4: "已解决",
  }

  // ── useEffect：页面一加载就自动执行 ──────────────────────────────────────
  // 第二个参数 [] 表示"只在页面第一次加载时执行一次"
  useEffect(() => {
    // 如果用户之前连过钱包，自动帮他重连
    checkIfWalletConnected()
  }, [])

  // ── 函数：检查 MetaMask 是否已经连接过 ──────────────────────────────────
  const checkIfWalletConnected = async () => {
    // window.ethereum 是 MetaMask 注入到浏览器里的对象
    // 如果没有，说明用户没装 MetaMask
    if (!window.ethereum) return

    // eth_accounts 返回用户已经授权过的账户列表（不会弹窗）
    const accounts = await window.ethereum.request({ method: "eth_accounts" })
    if (accounts.length > 0) {
      // 已经有授权账户，直接连接
      await setupProvider(accounts[0])
    }
  }

  // ── 函数：连接 MetaMask（用户点"连接钱包"按钮时调用）────────────────────
  const connectWallet = async () => {
    if (!window.ethereum) {
      alert("请先安装 MetaMask 浏览器插件！")
      return
    }

    try {
      // eth_requestAccounts 会弹出 MetaMask 窗口让用户选择账户并授权
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts"
      })
      await setupProvider(accounts[0])
    } catch (err) {
      console.error("用户拒绝了连接请求", err)
    }
  }

  // ── 函数：初始化 Ethers.js Provider 和 Signer ────────────────────────────
  const setupProvider = async (address) => {
    // BrowserProvider 把 MetaMask 包装成 Ethers.js 能用的格式
    const provider = new ethers.BrowserProvider(window.ethereum)

    // getSigner() 获取"签名者"对象 — 发送需要花钱的交易时必须用 signer
    const signer = await provider.getSigner()

    setAccount(address)
    setSigner(signer)

    // 连接成功后，加载页面需要的数据
    await fetchListings(signer)
    await fetchMyOrders(signer, address)
  }

  // ── 函数：从合约读取所有可接的 listings ─────────────────────────────────
  const fetchListings = async (signerObj) => {
    try {
      // 用 signer 创建合约实例
      // 参数：(合约地址, ABI目录, 签名者)
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signerObj)

      // 调用合约的 getActiveListings() 函数
      // await 表示"等它完成再继续"，因为读链上数据需要时间
      const result = await contract.getActiveListings()

      // 把链上返回的数据整理成前端好用的格式
      const formatted = result.map(l => ({
        id: Number(l.id),
        artist: l.artist,
        description: l.description,
        // formatEther 把 wei 单位转成人类看得懂的 ETH 数字
        price: ethers.formatEther(l.price),
      }))

      setListings(formatted)
    } catch (err) {
      console.error("读取 listings 失败", err)
    }
  }

  // ── 函数：读取我创建的订单（实际项目中建议用事件过滤来实现）────────────
  const fetchMyOrders = async (signerObj, address) => {
    // 这里简化处理 — 实际会用合约事件过滤：
    // contract.queryFilter(contract.filters.OrderCreated(null, address))
    // 暂时用空数组占位，等合约接口确定后填写
    setMyOrders([])
  }

  // ── 函数：Client 支付创建订单 ────────────────────────────────────────────
  const createOrder = async (listing) => {
    if (!signer) {
      alert("请先连接钱包！")
      return
    }

    setLoading(true)
    setTxStatus("等待 MetaMask 确认...")

    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)

      // parseEther 把 "0.5" 这种字符串转成合约能接受的 bigint 格式
      const priceInWei = ethers.parseEther(listing.price)

      // 调用合约的 createOrder 函数
      // { value: priceInWei } 表示"同时附带这么多 ETH"
      // MetaMask 会弹窗让用户确认
      const tx = await contract.createOrder(listing.id, { value: priceInWei })

      setTxStatus("交易已提交，等待链上确认（大约 15 秒）...")

      // tx.wait() 等待交易被矿工打包进区块
      // receipt 包含交易回执，比如消耗的 gas、触发的事件等
      const receipt = await tx.wait()

      setTxStatus(`订单创建成功！交易哈希: ${receipt.hash.slice(0, 10)}...`)
      setSelectedListing(null)

      // 刷新订单列表
      await fetchMyOrders(signer, account)

    } catch (err) {
      // 用户在 MetaMask 点了"拒绝"，或者合约 revert 了
      if (err.code === 4001) {
        setTxStatus("已取消：用户拒绝了交易")
      } else {
        setTxStatus(`失败：${err.message}`)
      }
    } finally {
      // finally 无论成功失败都会执行
      setLoading(false)
    }
  }

  // ── 函数：Client 确认满意，释放资金 ──────────────────────────────────────
  const confirmCompletion = async (orderId) => {
    setLoading(true)
    setTxStatus("等待 MetaMask 确认...")

    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const tx = await contract.confirmCompletion(orderId)
      await tx.wait()
      setTxStatus("已确认！资金已释放给 Artist ✓")
      await fetchMyOrders(signer, account)
    } catch (err) {
      setTxStatus(`失败：${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── 函数：Client 发起争议 ────────────────────────────────────────────────
  const raiseDispute = async (orderId) => {
    setLoading(true)
    setTxStatus("等待 MetaMask 确认（需要缴纳押金）...")

    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // 发起争议时 Client 需要缴纳押金（根据你们合约的实际金额调整）
      const depositAmount = ethers.parseEther("1.0")
      const tx = await contract.raiseDispute(orderId, { value: depositAmount })
      await tx.wait()
      setTxStatus("争议已发起，等待 Juror 介入...")
      await fetchMyOrders(signer, account)
    } catch (err) {
      setTxStatus(`失败：${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ─── return：这里写用户看到的界面 ────────────────────────────────────────
  // JSX 语法：看起来像 HTML，但实际上是 JavaScript
  // 区别：class → className，onclick → onClick，样式用 style={{ }} 双括号
  return (
    <div style={styles.page}>

      {/* ── 顶部导航栏 ── */}
      <header style={styles.header}>
        <div style={styles.logo}>DeCommission</div>
        <div style={styles.headerRight}>
          {/* 三元运算符：account 有值就显示地址，没有就显示连接按钮 */}
          {account ? (
            <div style={styles.walletConnected}>
              {/* slice 截取地址前6位和后4位，中间用...省略 */}
              {account.slice(0, 6)}...{account.slice(-4)}
            </div>
          ) : (
            <button style={styles.connectBtn} onClick={connectWallet}>
              连接钱包
            </button>
          )}
        </div>
      </header>

      <main style={styles.main}>

        {/* ── 交易状态提示条 ── */}
        {/* && 的意思：txStatus 有内容时才显示这个 div */}
        {txStatus && (
          <div style={styles.statusBar}>
            {loading && <span style={styles.spinner}>⏳</span>}
            {txStatus}
          </div>
        )}

        {/* ── 未连接钱包时显示引导 ── */}
        {!account && (
          <div style={styles.welcomeCard}>
            <div style={styles.welcomeIcon}>🎨</div>
            <h2 style={styles.welcomeTitle}>欢迎来到 DeCommission</h2>
            <p style={styles.welcomeText}>
              去中心化数字艺术委托平台。连接钱包开始下单，资金由智能合约托管，安全透明。
            </p>
            <button style={styles.connectBtnLarge} onClick={connectWallet}>
              连接 MetaMask 开始
            </button>
          </div>
        )}

        {/* ── 已连接时显示主内容 ── */}
        {account && (
          <div style={styles.content}>

            {/* ── 左侧：可接单列表 ── */}
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>可委托的 Artist</h2>

              {listings.length === 0 ? (
                <p style={styles.emptyText}>暂无可接单的 Artist，稍后再来～</p>
              ) : (
                /* listings.map() = 遍历数组，每一项生成一个卡片 */
                listings.map(listing => (
                  /* key 是 React 内部用来追踪列表项的，必须唯一 */
                  <div key={listing.id} style={styles.listingCard}>
                    <div style={styles.listingHeader}>
                      <div>
                        <div style={styles.listingArtist}>
                          {listing.artist.slice(0, 6)}...{listing.artist.slice(-4)}
                        </div>
                        <div style={styles.listingDesc}>{listing.description}</div>
                      </div>
                      <div style={styles.listingPrice}>{listing.price} ETH</div>
                    </div>

                    {/* 点击"选择"展开确认区域 */}
                    <button
                      style={styles.selectBtn}
                      onClick={() => setSelectedListing(listing)}
                    >
                      选择这位 Artist →
                    </button>

                    {/* 条件渲染：只有当这个 listing 被选中时才显示确认区域 */}
                    {selectedListing?.id === listing.id && (
                      <div style={styles.confirmBox}>
                        <p style={styles.confirmText}>
                          确认支付 <strong>{listing.price} ETH</strong> 委托这位 Artist？
                          <br/>
                          <span style={styles.confirmNote}>
                            资金将由智能合约托管，Artist 完成后才会收到。
                          </span>
                        </p>
                        <div style={styles.confirmActions}>
                          <button
                            style={styles.confirmBtn}
                            onClick={() => createOrder(listing)}
                            disabled={loading}
                          >
                            {loading ? "处理中..." : "确认支付"}
                          </button>
                          <button
                            style={styles.cancelBtn}
                            onClick={() => setSelectedListing(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </section>

            {/* ── 右侧：我的订单 ── */}
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>我的订单</h2>

              {myOrders.length === 0 ? (
                <p style={styles.emptyText}>还没有订单，从左边选择 Artist 开始委托吧！</p>
              ) : (
                myOrders.map(order => (
                  <div key={order.id} style={styles.orderCard}>
                    <div style={styles.orderHeader}>
                      <span style={styles.orderId}>订单 #{order.id}</span>
                      <span style={styles.orderStatus}>
                        {ORDER_STATUS[order.status]}
                      </span>
                    </div>
                    <div style={styles.orderAmount}>{order.amount} ETH</div>

                    {/* 根据订单状态显示不同的操作按钮 */}
                    <div style={styles.orderActions}>

                      {/* 状态 1 = 已交付，Client 可以确认或发起争议 */}
                      {order.status === 1 && (
                        <>
                          <button
                            style={styles.confirmBtn}
                            onClick={() => confirmCompletion(order.id)}
                            disabled={loading}
                          >
                            ✓ 确认满意，释放资金
                          </button>
                          <button
                            style={styles.disputeBtn}
                            onClick={() => raiseDispute(order.id)}
                            disabled={loading}
                          >
                            ⚠ 发起争议
                          </button>
                        </>
                      )}

                      {/* 状态 2 = 已完成 */}
                      {order.status === 2 && (
                        <span style={styles.doneTag}>订单已完成 ✓</span>
                      )}

                      {/* 状态 3 = 争议中 */}
                      {order.status === 3 && (
                        <span style={styles.disputeTag}>争议处理中，等待 Juror 投票...</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </section>

          </div>
        )}
      </main>
    </div>
  )
}

// ─── 样式对象 ─────────────────────────────────────────────────────────────────
// React 里的样式写法：JS 对象，属性名用驼峰命名（backgroundColor 而不是 background-color）
// 等同于 CSS，只是语法不同
const styles = {
  page: {
    minHeight: "100vh",
    background: "#0d0d0f",
    color: "#e8e6de",
    fontFamily: "'DM Sans', 'Noto Sans SC', sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 40px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    backdropFilter: "blur(12px)",
    position: "sticky",
    top: 0,
    background: "rgba(13,13,15,0.9)",
    zIndex: 10,
  },
  logo: {
    fontSize: "18px",
    fontWeight: "600",
    letterSpacing: "0.05em",
    color: "#a8f5d4",
  },
  headerRight: { display: "flex", alignItems: "center", gap: "12px" },
  walletConnected: {
    padding: "8px 16px",
    background: "rgba(168,245,212,0.1)",
    border: "1px solid rgba(168,245,212,0.3)",
    borderRadius: "20px",
    fontSize: "13px",
    color: "#a8f5d4",
    fontFamily: "monospace",
  },
  connectBtn: {
    padding: "8px 20px",
    background: "#a8f5d4",
    color: "#0d0d0f",
    border: "none",
    borderRadius: "20px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
  },
  main: { padding: "40px" },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "14px 20px",
    background: "rgba(168,245,212,0.08)",
    border: "1px solid rgba(168,245,212,0.2)",
    borderRadius: "10px",
    marginBottom: "30px",
    fontSize: "14px",
    color: "#a8f5d4",
  },
  spinner: { fontSize: "16px" },
  welcomeCard: {
    maxWidth: "480px",
    margin: "80px auto",
    textAlign: "center",
    padding: "48px 40px",
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "20px",
  },
  welcomeIcon: { fontSize: "48px", marginBottom: "20px" },
  welcomeTitle: { fontSize: "24px", fontWeight: "600", marginBottom: "12px", color: "#fff" },
  welcomeText: { fontSize: "15px", color: "rgba(232,230,222,0.6)", lineHeight: "1.7", marginBottom: "32px" },
  connectBtnLarge: {
    padding: "14px 36px",
    background: "#a8f5d4",
    color: "#0d0d0f",
    border: "none",
    borderRadius: "12px",
    fontSize: "15px",
    fontWeight: "700",
    cursor: "pointer",
    letterSpacing: "0.02em",
  },
  content: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "32px",
    maxWidth: "1100px",
    margin: "0 auto",
  },
  section: {},
  sectionTitle: {
    fontSize: "13px",
    fontWeight: "600",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "rgba(232,230,222,0.4)",
    marginBottom: "16px",
  },
  listingCard: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "12px",
    transition: "border-color 0.2s",
  },
  listingHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" },
  listingArtist: { fontSize: "12px", color: "rgba(232,230,222,0.4)", fontFamily: "monospace", marginBottom: "6px" },
  listingDesc: { fontSize: "15px", color: "#e8e6de", lineHeight: "1.5" },
  listingPrice: { fontSize: "18px", fontWeight: "700", color: "#a8f5d4", whiteSpace: "nowrap" },
  selectBtn: {
    width: "100%",
    padding: "10px",
    background: "transparent",
    border: "1px solid rgba(168,245,212,0.3)",
    borderRadius: "8px",
    color: "#a8f5d4",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    letterSpacing: "0.03em",
  },
  confirmBox: {
    marginTop: "14px",
    padding: "16px",
    background: "rgba(168,245,212,0.06)",
    border: "1px solid rgba(168,245,212,0.15)",
    borderRadius: "10px",
  },
  confirmText: { fontSize: "14px", color: "#e8e6de", lineHeight: "1.6", marginBottom: "14px" },
  confirmNote: { fontSize: "12px", color: "rgba(232,230,222,0.5)" },
  confirmActions: { display: "flex", gap: "10px" },
  confirmBtn: {
    flex: 1,
    padding: "10px",
    background: "#a8f5d4",
    color: "#0d0d0f",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
  },
  cancelBtn: {
    padding: "10px 16px",
    background: "transparent",
    color: "rgba(232,230,222,0.5)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
    fontSize: "13px",
    cursor: "pointer",
  },
  orderCard: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "12px",
  },
  orderHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" },
  orderId: { fontSize: "13px", color: "rgba(232,230,222,0.4)", fontFamily: "monospace" },
  orderStatus: {
    padding: "4px 10px",
    background: "rgba(168,245,212,0.1)",
    border: "1px solid rgba(168,245,212,0.2)",
    borderRadius: "10px",
    fontSize: "12px",
    color: "#a8f5d4",
  },
  orderAmount: { fontSize: "22px", fontWeight: "700", color: "#fff", marginBottom: "16px" },
  orderActions: { display: "flex", flexDirection: "column", gap: "8px" },
  disputeBtn: {
    padding: "10px",
    background: "transparent",
    border: "1px solid rgba(226,75,74,0.4)",
    borderRadius: "8px",
    color: "#f09595",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
  },
  doneTag: { fontSize: "13px", color: "#a8f5d4" },
  disputeTag: { fontSize: "13px", color: "#f09595" },
  emptyText: { fontSize: "14px", color: "rgba(232,230,222,0.35)", fontStyle: "italic", padding: "20px 0" },
}
