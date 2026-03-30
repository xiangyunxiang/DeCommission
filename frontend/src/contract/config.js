import addresses from "./deployedAddresses.json"
import DataFetcherArtifact from "../../../backend/artifacts/contracts/DataFetcher.sol/DataFetcher.json"

export const CONTRACT_ADDRESS              = addresses.ProductMarket
export const REVIEWER_REGISTRY_ADDRESS     = addresses.ReviewerRegistry
export const DISPUTE_MANAGER_ADDRESS       = addresses.DisputeManager
export const DATA_FETCHER_ADDRESS          = addresses.DataFetcher

// ProductMarket ABI — matches backend/contracts/ProductMarket.sol
export const CONTRACT_ABI = [
  // ── Write functions ────────────────────────────────────────────

  // Buyer creates a commission order with ETH escrowed
  "function createCommission(string calldata ipfsHash, uint256 price) payable returns (uint256)",

  // Artist accepts an open commission
  "function acceptCommission(uint256 productId)",

  // Artist submits delivery (watermarked work CID)
  "function confirmShipment(uint256 productId, string calldata deliveryIpfsHash)",

  // Buyer confirms receipt → releases escrowed funds to artist
  "function confirmReceipt(uint256 productId)",

  // Buyer cancels an unaccepted commission → refunds escrowed ETH
  "function cancelCommission(uint256 productId)",

  // Either party raises a dispute (Sold or Shipped status)
  "function raiseDispute(uint256 productId)",

  // Deposit / withdraw mandatory deposit
  "function deposit() payable",
  "function withdrawDeposit(uint256 amount)",

  // ── Read functions ─────────────────────────────────────────────

  "function getProduct(uint256 productId) view returns (tuple(uint256 id, address seller, address buyer, string ipfsHash, string deliveryIpfsHash, uint256 price, uint256 listedAt, uint8 status))",
  "function getProductsByBuyer(address buyer) view returns (uint256[])",
  "function getProductsBySeller(address seller) view returns (uint256[])",
  "function getListedProducts() view returns (uint256[])",
  "function getLatestProductId() view returns (uint256)",
  "function depositBalance(address) view returns (uint256)",

  // ── Events ─────────────────────────────────────────────────────

  "event CommissionCreated(uint256 indexed id, address indexed buyer, string ipfsHash, uint256 price)",
  "event CommissionAccepted(uint256 indexed id, address indexed seller)",
  "event ProductShipped(uint256 indexed id, string deliveryIpfsHash)",
  "event ProductCompleted(uint256 indexed id)",
  "event ProductDisputed(uint256 indexed id, address raisedBy)",
  "event ProductDelisted(uint256 indexed id)",
]

// DisputeManager ABI — matches backend/contracts/DisputeManager.sol
export const DISPUTE_MANAGER_ABI = [
  // ── Write functions ────────────────────────────────────────────
  "function stakeToEnter(uint256 productId) payable",
  "function withdrawStake(uint256 productId)",
  "function castVote(uint256 productId, uint8 vote)",
  "function settleDispute(uint256 productId)",

  // ── Read functions ─────────────────────────────────────────────
  "function getDisputesByReviewer(address reviewer) view returns (uint256[])",
  "function getReviewerDisputeDetails(address reviewer) view returns (tuple(uint256 productId, address buyer, address seller, uint256 buyerVotes, uint256 sellerVotes, uint256 deadline, bool resolved, bool buyerWon, uint8 myVote, bool myHasStaked, bool myHasVoted)[])",
  "function getDisputeInfo(uint256 productId) view returns (address[] assignedReviewers, uint256 buyerVotes, uint256 sellerVotes, uint256 deadline, bool resolved, bool buyerWon)",
  "function getReviewerStakeStatus(uint256 productId, address reviewer) view returns (bool hasStaked, bool hasVoted)",

  // ── Events ─────────────────────────────────────────────────────
  "event ReviewerStaked(uint256 indexed productId, address indexed reviewer)",
  "event ReviewerWithdrew(uint256 indexed productId, address indexed reviewer)",
  "event VoteCast(uint256 indexed productId, address indexed reviewer, uint8 vote)",
  "event DisputeResolved(uint256 indexed productId, bool buyerWon, uint256 buyerVotes, uint256 sellerVotes)",
]

// DataFetcher ABI — imported directly from compiled artifact (avoids manual ABI drift)
export const DATA_FETCHER_ABI = DataFetcherArtifact.abi

// ReviewerRegistry ABI — for juror pool registration
export const REVIEWER_REGISTRY_ABI = [
  "function isReviewer(address) view returns (bool)",
  "function completedSales(address) view returns (uint256)",
  "function getPoolSize() view returns (uint256)",
  "function getPool() view returns (address[])",
  "function registerAsReviewer()",
  "function forceRegister(address addr)",
  "event ReviewerRegistered(address indexed reviewer)",
]
