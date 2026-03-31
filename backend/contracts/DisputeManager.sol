// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./ProductMarket.sol";

contract DisputeManager {
    ReviewerRegistry public registry;
    ProductMarket public market;

    uint256 public constant VOTING_PERIOD = 1 days;

    // 动态分级参数（按订单金额）
    // Tier 1 (Small):  price < 1 ETH   → 3 jurors, 0.05 ETH 质押
    // Tier 2 (Medium): 1 ETH <= price < 5 ETH → 5 jurors, 0.10 ETH 质押
    // Tier 3 (Large):  price >= 5 ETH  → 7 jurors, 0.20 ETH 质押
    uint256 public constant TIER1_THRESHOLD = 1 ether;
    uint256 public constant TIER2_THRESHOLD = 5 ether;

    uint256 public constant TIER1_REVIEWER_COUNT = 3;
    uint256 public constant TIER2_REVIEWER_COUNT = 5;
    uint256 public constant TIER3_REVIEWER_COUNT = 7;

    uint256 public constant TIER1_REVIEWER_STAKE = 0.05 ether;
    uint256 public constant TIER2_REVIEWER_STAKE = 0.10 ether;
    uint256 public constant TIER3_REVIEWER_STAKE = 0.20 ether;

    uint256 public constant TIER1_PLATFORM_FEE = 0.02 ether;
    uint256 public constant TIER2_PLATFORM_FEE = 0.05 ether;
    uint256 public constant TIER3_PLATFORM_FEE = 0.10 ether;

    enum Vote { None, BuyerWins, SellerWins }

    struct ReviewerInfo {
        bool hasStaked;   // 是否已质押进入
        bool hasVoted;    // 是否已投票
        Vote vote;        // 投的票
    }

    struct Dispute {
        uint256 productId;
        address buyer;
        address seller;
        uint256 orderPrice;       // 订单金额，用于确定tier参数
        uint256 reviewerCount;    // 本次争议的juror人数
        uint256 reviewerStake;    // 本次争议每个juror的质押金额
        uint256 platformFee;      // 本次争议的平台费
        address[] assignedReviewers;
        mapping(address => ReviewerInfo) reviewerInfo;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 stakedReviewerCount;  // 已质押进入的评审员数
        uint256 deadline;
        bool resolved;
        bool buyerWon;
    }

    mapping(uint256 => Dispute) private disputes;
    mapping(address => uint256[]) private reviewerDisputes;
    mapping(address => uint256) public reviewerEarnings;

    // 平台收益
    uint256 public platformBalance;

    event DisputeOpened(uint256 indexed productId, address[] reviewers);
    event ReviewerStaked(uint256 indexed productId, address indexed reviewer);
    event ReviewerWithdrew(uint256 indexed productId, address indexed reviewer);
    event VoteCast(uint256 indexed productId, address indexed reviewer, Vote vote);
    event DisputeResolved(uint256 indexed productId, bool buyerWon, uint256 buyerVotes, uint256 sellerVotes);
    event TieDetected(uint256 indexed productId);

    constructor(address _registry, address _market) {
        registry = ReviewerRegistry(_registry);
        market = ProductMarket(payable(_market));
    }

    // ── 分级查询工具函数（供前端查询juror需质押多少）──────────────────

    function getTier(uint256 price) public pure returns (uint256) {
        if (price < TIER1_THRESHOLD) return 1;
        if (price < TIER2_THRESHOLD) return 2;
        return 3;
    }

    function getReviewerCountForPrice(uint256 price) public pure returns (uint256) {
        uint256 tier = getTier(price);
        if (tier == 1) return TIER1_REVIEWER_COUNT;
        if (tier == 2) return TIER2_REVIEWER_COUNT;
        return TIER3_REVIEWER_COUNT;
    }

    function getReviewerStakeForPrice(uint256 price) public pure returns (uint256) {
        uint256 tier = getTier(price);
        if (tier == 1) return TIER1_REVIEWER_STAKE;
        if (tier == 2) return TIER2_REVIEWER_STAKE;
        return TIER3_REVIEWER_STAKE;
    }

    function getPlatformFeeForPrice(uint256 price) public pure returns (uint256) {
        uint256 tier = getTier(price);
        if (tier == 1) return TIER1_PLATFORM_FEE;
        if (tier == 2) return TIER2_PLATFORM_FEE;
        return TIER3_PLATFORM_FEE;
    }

    function openDispute(
        uint256 productId,
        address buyer,
        address seller,
        bool /*aiUsageAllowed - unused in product marketplace*/,
        uint256 orderPrice
    ) external {
        require(msg.sender == address(market), "Only market contract");

        Dispute storage d = disputes[productId];
        d.productId = productId;
        d.buyer = buyer;
        d.seller = seller;
        d.orderPrice = orderPrice;
        d.reviewerCount = getReviewerCountForPrice(orderPrice);
        d.reviewerStake = getReviewerStakeForPrice(orderPrice);
        d.platformFee = getPlatformFeeForPrice(orderPrice);
        d.deadline = block.timestamp + VOTING_PERIOD;

        // 随机assign评审员，排除买卖双方
        d.assignedReviewers = registry.selectReviewers(buyer, seller, d.reviewerCount);
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            reviewerDisputes[d.assignedReviewers[i]].push(productId);
        }

        emit DisputeOpened(productId, d.assignedReviewers);
    }

    // ── 评审员质押进入（质押后才能投票）────────────────────────────
    function stakeToEnter(uint256 productId) external payable {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(msg.value == d.reviewerStake, "Incorrect stake amount");

        bool isAssigned = false;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (d.assignedReviewers[i] == msg.sender) {
                isAssigned = true;
                break;
            }
        }
        require(isAssigned, "Not assigned to this dispute");
        require(!d.reviewerInfo[msg.sender].hasStaked, "Already staked");

        d.reviewerInfo[msg.sender].hasStaked = true;
        d.stakedReviewerCount++;

        emit ReviewerStaked(productId, msg.sender);
    }

    // ── 评审员投票前可退出（取回质押）───────────────────────────────
    function withdrawStake(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(d.reviewerInfo[msg.sender].hasStaked, "Not staked");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted, cannot withdraw");

        d.reviewerInfo[msg.sender].hasStaked = false;
        d.stakedReviewerCount--;

        payable(msg.sender).transfer(d.reviewerStake);
        emit ReviewerWithdrew(productId, msg.sender);
    }

    // ── 评审员投票 ────────────────────────────────────────────────
    function castVote(uint256 productId, Vote vote) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(vote != Vote.None, "Invalid vote");
        require(d.reviewerInfo[msg.sender].hasStaked, "Must stake before voting");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted");

        d.reviewerInfo[msg.sender].vote = vote;
        d.reviewerInfo[msg.sender].hasVoted = true;

        if (vote == Vote.BuyerWins) {
            d.buyerVotes++;
        } else {
            d.sellerVotes++;
        }

        emit VoteCast(productId, msg.sender, vote);
    }

    // ── 结算 ──────────────────────────────────────────────────────
    function settleDispute(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp >= d.deadline, "Voting still ongoing");

        if (d.buyerVotes == d.sellerVotes) {
            // 平票：重置，重新随机assign评审员，开启新一轮
            d.deadline = block.timestamp + VOTING_PERIOD;
            d.buyerVotes = 0;
            d.sellerVotes = 0;

            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address r = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    payable(r).transfer(d.reviewerStake);
                }
                // 已投票的评审员：重置投票状态，但质押留着进入下一轮
                ri.hasVoted = false;
                ri.vote = Vote.None;
            }

            d.assignedReviewers = registry.selectReviewers(d.buyer, d.seller, d.reviewerCount);
            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                reviewerDisputes[d.assignedReviewers[i]].push(productId);
            }

            emit TieDetected(productId);
            return;
        }

        bool buyerWon = d.buyerVotes > d.sellerVotes;
        d.resolved = true;
        d.buyerWon = buyerWon;

        Vote winningVote = buyerWon ? Vote.BuyerWins : Vote.SellerWins;

        // 奖金池 = 输家的 dispute stake + 投错票评审员的质押
        uint256 disputeStake = market.getDisputeStakeForPrice(d.orderPrice);
        uint256 prizePool = disputeStake;

        uint256 correctVoterCount = 0;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked && ri.hasVoted) {
                if (ri.vote == winningVote) {
                    correctVoterCount++;
                } else {
                    // 只有投错票才没收质押进奖金池
                    prizePool += d.reviewerStake;
                }
            }
        }

        // 扣除平台费
        uint256 actualPlatformFee = prizePool >= d.platformFee ? d.platformFee : prizePool;
        platformBalance += actualPlatformFee;
        uint256 remainingPrize = prizePool - actualPlatformFee;

        // 每个投对票的评审员的分成
        uint256 rewardPerCorrectVoter = correctVoterCount > 0
            ? remainingPrize / correctVoterCount
            : 0;

        // 发放评审员奖励（退回质押 + 分成）
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked) {
                if (ri.hasVoted && ri.vote == winningVote) {
                    // 投对票：退回质押 + 分奖金
                    uint256 payout = d.reviewerStake + rewardPerCorrectVoter;
                    reviewerEarnings[r] += rewardPerCorrectVoter;
                    payable(r).transfer(payout);
                } else if (!ri.hasVoted) {
                    // 质押了但没投票：退回质押，无惩罚
                    payable(r).transfer(d.reviewerStake);
                }
                // 投错票：什么都不退，质押已进奖金池
            }
        }

        // 通知 ProductMarket 结算订单金额和双方质押
        // 赢家：退回 disputeStake；输家：质押已进奖金池，退 0
        uint256 buyerStakeReturn = buyerWon ? disputeStake : 0;
        uint256 sellerStakeReturn = buyerWon ? 0 : disputeStake;

        // 把赢家的质押金转给 market 合约，让它一起付给赢家
        (bool sent, ) = address(market).call{value: disputeStake}("");
        require(sent, "Failed to send stake to market");

        market.resolveByDispute(productId, buyerWon, buyerStakeReturn, sellerStakeReturn);

        emit DisputeResolved(productId, buyerWon, d.buyerVotes, d.sellerVotes);
    }

    // ── 平台提款 ──────────────────────────────────────────────────
    // demo 用，实际应该加 owner 权限控制
    function withdrawPlatformFee(address to) external {
        uint256 amount = platformBalance;
        platformBalance = 0;
        payable(to).transfer(amount);
    }

    // ── 查询函数 ──────────────────────────────────────────────────

    struct DisputeView {
        uint256 productId;
        address buyer;
        address seller;
        uint256 orderPrice;
        uint256 reviewerCount;
        uint256 reviewerStake;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool resolved;
        bool buyerWon;
        uint8 myVote;
        bool myHasStaked;
        bool myHasVoted;
    }

    struct PartyDisputeView {
        uint256 productId;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool resolved;
        bool buyerWon;
    }

    function getReviewerDisputeDetails(address reviewer)
        external view returns (DisputeView[] memory)
    {
        uint256[] memory ids = reviewerDisputes[reviewer];
        DisputeView[] memory result = new DisputeView[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            Dispute storage d = disputes[ids[i]];
            ReviewerInfo storage ri = d.reviewerInfo[reviewer];
            result[i] = DisputeView({
                productId: ids[i],
                buyer: d.buyer,
                seller: d.seller,
                orderPrice: d.orderPrice,
                reviewerCount: d.reviewerCount,
                reviewerStake: d.reviewerStake,
                buyerVotes: d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline: d.deadline,
                resolved: d.resolved,
                buyerWon: d.buyerWon,
                myVote: uint8(ri.vote),
                myHasStaked: ri.hasStaked,
                myHasVoted: ri.hasVoted
            });
        }
        return result;
    }

    function getDisputesByParty(uint256[] calldata productIds)
        external view returns (PartyDisputeView[] memory)
    {
        PartyDisputeView[] memory result = new PartyDisputeView[](productIds.length);
        for (uint i = 0; i < productIds.length; i++) {
            Dispute storage d = disputes[productIds[i]];
            result[i] = PartyDisputeView({
                productId: productIds[i],
                buyerVotes: d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline: d.deadline,
                resolved: d.resolved,
                buyerWon: d.buyerWon
            });
        }
        return result;
    }

    function getDisputesByReviewer(address reviewer)
        external view returns (uint256[] memory)
    {
        return reviewerDisputes[reviewer];
    }

    function getDisputeInfo(uint256 productId) external view returns (
        address[] memory assignedReviewers,
        uint256 reviewerStake,
        uint256 buyerVotes,
        uint256 sellerVotes,
        uint256 deadline,
        bool resolved,
        bool buyerWon
    ) {
        Dispute storage d = disputes[productId];
        return (
            d.assignedReviewers,
            d.reviewerStake,
            d.buyerVotes,
            d.sellerVotes,
            d.deadline,
            d.resolved,
            d.buyerWon
        );
    }

    function getReviewerVote(uint256 productId, address reviewer)
        external view returns (Vote)
    {
        return disputes[productId].reviewerInfo[reviewer].vote;
    }

    function getReviewerStakeStatus(uint256 productId, address reviewer)
        external view returns (bool hasStaked, bool hasVoted)
    {
        ReviewerInfo storage ri = disputes[productId].reviewerInfo[reviewer];
        return (ri.hasStaked, ri.hasVoted);
    }

    receive() external payable {}
}
