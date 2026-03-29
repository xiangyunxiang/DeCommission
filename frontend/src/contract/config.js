export const CONTRACT_ADDRESS = "0x_Your contract address is pasted here"

//跑完 npx hardhat compile 后
// 复制后端生成的 JSON 文件里面的 abi 字段
export const CONTRACT_ABI = [
  // 函数：Client 支付创建订单
  // inputs: listingId (uint256) = Artist 发布的listing编号
  // payable: 调用时要附带 ETH
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
