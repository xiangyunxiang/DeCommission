// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./DisputeManager.sol";

contract ProductMarket {
    ReviewerRegistry public registry;
    DisputeManager public disputeManager;

    uint256 public constant LISTING_DEADLINE = 7 days;  // 商品上架有效期
    uint256 public constant MIN_DEPOSIT = 1 ether;

    // 买卖方争议质押分级（与 DisputeManager tier 对应）
    // Tier 1 (Small):  price < 1 ETH   → 双方各质押 0.10 ETH
    // Tier 2 (Medium): 1 ETH <= price < 5 ETH → 双方各质押 0.30 ETH
    // Tier 3 (Large):  price >= 5 ETH  → 双方各质押 0.50 ETH
    uint256 public constant TIER1_THRESHOLD   = 1 ether;
    uint256 public constant TIER2_THRESHOLD   = 5 ether;

    uint256 public constant TIER1_DISPUTE_STAKE = 0.10 ether;
    uint256 public constant TIER2_DISPUTE_STAKE = 0.30 ether;
    uint256 public constant TIER3_DISPUTE_STAKE = 0.50 ether;

    uint256 private productCounter;

    enum ProductStatus {
        Listed,      // 卖家已上架，等待买家
        Sold,        // 买家已下单，资金锁定
        Shipped,     // 卖家已发货
        Completed,   // 买家确认收货，交易完成
        Disputed,    // 争议中
        Resolved     // 争议已解决
    }

    struct Product {
        uint256 id;
        address seller;
        address buyer;
        string ipfsHash;         // 商品描述（存IPFS）
        string deliveryIpfsHash; // 发货凭证（存IPFS，如快递单号等）
        uint256 price;           // 卖家定价
        uint256 listedAt;        // 上架时间
        ProductStatus status;
    }

    mapping(uint256 => Product) public products;
    mapping(address => uint256[]) private partyDisputes;
    mapping(address => uint256) public depositBalance;
    mapping(address => uint256) public activeDisputeCount; // 有多少活跃争议，提款时用

    event ProductListed(uint256 indexed id, address indexed seller, string ipfsHash, uint256 price);
    event ProductPurchased(uint256 indexed id, address indexed buyer);
    event ProductShipped(uint256 indexed id, string deliveryIpfsHash);
    event ProductCompleted(uint256 indexed id);
    event ProductDisputed(uint256 indexed id, address raisedBy);
    event ProductDelisted(uint256 indexed id);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(address _registry) {
        if (_registry != address(0)) {
            registry = ReviewerRegistry(_registry);
        }
    }

    function setRegistry(address _registry) external {
        registry = ReviewerRegistry(_registry);
    }

    function setDisputeManager(address _dm) external {
        require(address(disputeManager) == address(0), "Already set");
        disputeManager = DisputeManager(payable(_dm));
    }

    // ── 分级质押查询（供 DisputeManager 和前端调用）─────────────────

    function getDisputeStakeForPrice(uint256 price) public pure returns (uint256) {
        if (price < TIER1_THRESHOLD) return TIER1_DISPUTE_STAKE;
        if (price < TIER2_THRESHOLD) return TIER2_DISPUTE_STAKE;
        return TIER3_DISPUTE_STAKE;
    }

    // ── 押金系统 ──────────────────────────────────────────────────

    // 用户充值押金
    function deposit() external payable {
        require(msg.value > 0, "Must send ETH");
        depositBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    // 用户提取押金（没有活跃争议时才能提）
    function withdrawDeposit(uint256 amount) external {
        require(activeDisputeCount[msg.sender] == 0, "Cannot withdraw during active dispute");
        require(depositBalance[msg.sender] >= amount, "Insufficient deposit balance");
        depositBalance[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ── 商品流程 ───────────────────────────────────────────────────

    // 卖家上架商品
    function listProduct(
        string calldata ipfsHash,
        uint256 price
    ) external returns (uint256) {
        require(price > 0, "Price must be greater than 0");
        require(depositBalance[msg.sender] >= MIN_DEPOSIT, "Insufficient deposit: need 1 ETH");

        productCounter++;
        products[productCounter] = Product({
            id: productCounter,
            seller: msg.sender,
            buyer: address(0),
            ipfsHash: ipfsHash,
            deliveryIpfsHash: "",
            price: price,
            listedAt: block.timestamp,
            status: ProductStatus.Listed
        });

        emit ProductListed(productCounter, msg.sender, ipfsHash, price);
        return productCounter;
    }

    // 买家下单购买（附带 ETH = price）
    function purchaseProduct(uint256 productId) external payable {
        Product storage p = products[productId];
        require(p.status == ProductStatus.Listed, "Not available");
        require(p.seller != msg.sender, "Seller cannot buy own product");
        require(msg.value == p.price, "Must send exact price");
        require(depositBalance[msg.sender] >= MIN_DEPOSIT, "Insufficient deposit: need 1 ETH");

        p.buyer = msg.sender;
        p.status = ProductStatus.Sold;

        emit ProductPurchased(productId, msg.sender);
    }

    // 卖家确认发货
    function confirmShipment(uint256 productId, string calldata deliveryIpfsHash) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller, "Not the seller");
        require(p.status == ProductStatus.Sold, "Wrong status");

        p.deliveryIpfsHash = deliveryIpfsHash;
        p.status = ProductStatus.Shipped;

        emit ProductShipped(productId, deliveryIpfsHash);
    }

    // 买家确认收货，资金释放给卖家
    function confirmReceipt(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.buyer, "Not the buyer");
        require(p.status == ProductStatus.Shipped, "Not shipped yet");

        p.status = ProductStatus.Completed;
        registry.recordSale(p.seller);

        payable(p.seller).transfer(p.price);
        emit ProductCompleted(productId);
    }

    // 卖家下架（仅 Listed 状态可以）
    function delistProduct(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller, "Not the seller");
        require(p.status == ProductStatus.Listed, "Cannot delist after purchase");

        // 复用 Resolved 状态标记下架（或可单独加 Delisted 状态，为简单起见复用）
        p.status = ProductStatus.Resolved;
        emit ProductDelisted(productId);
    }

    // 发起争议（买卖双方均可，Sold 或 Shipped 状态）
    function raiseDispute(uint256 productId) external {
        Product storage p = products[productId];
        require(
            msg.sender == p.buyer || msg.sender == p.seller,
            "Not involved in this product"
        );
        require(
            p.status == ProductStatus.Sold || p.status == ProductStatus.Shipped,
            "Can only dispute after purchase"
        );

        // 根据订单金额动态计算双方质押金额
        uint256 disputeStake = getDisputeStakeForPrice(p.price);

        require(depositBalance[p.buyer] >= disputeStake, "Buyer insufficient deposit for dispute");
        require(depositBalance[p.seller] >= disputeStake, "Seller insufficient deposit for dispute");

        depositBalance[p.buyer] -= disputeStake;
        depositBalance[p.seller] -= disputeStake;

        activeDisputeCount[p.buyer]++;
        activeDisputeCount[p.seller]++;

        p.status = ProductStatus.Disputed;
        partyDisputes[p.buyer].push(productId);
        partyDisputes[p.seller].push(productId);

        // 把双方质押金实际转给 DisputeManager
        (bool sent, ) = address(disputeManager).call{value: disputeStake * 2}("");
        require(sent, "Failed to send stakes to DisputeManager");

        // aiUsageAllowed 在商品场景不适用，传 false 即可；传入订单金额用于分级
        disputeManager.openDispute(productId, p.buyer, p.seller, false, p.price);

        emit ProductDisputed(productId, msg.sender);
    }

    // 由 DisputeManager 在争议解决后调用
    function resolveByDispute(
        uint256 productId,
        bool buyerWins,
        uint256 buyerStakeReturn,   // 退给买家的质押金额
        uint256 sellerStakeReturn   // 退给卖家的质押金额
    ) external {
        require(msg.sender == address(disputeManager), "Only dispute manager");
        Product storage p = products[productId];
        require(p.status == ProductStatus.Disputed, "Not in dispute");

        p.status = ProductStatus.Resolved;

        // 归还活跃争议计数
        activeDisputeCount[p.buyer]--;
        activeDisputeCount[p.seller]--;

        if (buyerWins) {
            // 买家：退回商品款 + 退回质押
            payable(p.buyer).transfer(p.price + buyerStakeReturn);
            // 卖家质押已在 DisputeManager 处理，这里不退
            if (sellerStakeReturn > 0) {
                payable(p.seller).transfer(sellerStakeReturn);
            }
        } else {
            // 卖家：收到商品款 + 退回质押
            registry.recordSale(p.seller);
            payable(p.seller).transfer(p.price + sellerStakeReturn);
            // 买家质押已在 DisputeManager 处理，这里不退
            if (buyerStakeReturn > 0) {
                payable(p.buyer).transfer(buyerStakeReturn);
            }
        }
    }

    // ── 查询函数 ──────────────────────────────────────────────────

    function getProduct(uint256 productId) external view returns (Product memory) {
        return products[productId];
    }

    function getLatestProductId() external view returns (uint256) {
        return productCounter;
    }

    function getListedProducts() external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].status == ProductStatus.Listed) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].status == ProductStatus.Listed) result[idx++] = i;
        }
        return result;
    }

    function getProductsBySeller(address seller) external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].seller == seller) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].seller == seller) result[idx++] = i;
        }
        return result;
    }

    function getProductsByBuyer(address buyer) external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].buyer == buyer) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].buyer == buyer) result[idx++] = i;
        }
        return result;
    }

    function getMyDisputes(address party) external view returns (uint256[] memory) {
        return partyDisputes[party];
    }

    receive() external payable {}
}
