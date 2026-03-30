// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ProductMarket.sol";
import "./DisputeManager.sol";

contract DataFetcher {
    ProductMarket public market;
    DisputeManager public dispute;

    constructor(address _market, address _dispute) {
        market = ProductMarket(payable(_market));
        dispute = DisputeManager(payable(_dispute));
    }

    struct ProductSummary {
        uint256 id;
        address seller;
        address buyer;
        string ipfsHash;
        string deliveryIpfsHash;
        uint256 price;
        uint256 listedAt;
        uint8 status;
    }

    // ── 买家 Dashboard ──────────────────────────────────────────
    // 返回：买家创建的所有委托 + 买家相关争议进度
    struct BuyerDashboard {
        ProductSummary[] commissions;
        DisputeManager.PartyDisputeView[] disputes;
    }

    function getBuyerDashboard(address buyer)
        external view returns (BuyerDashboard memory)
    {
        uint256[] memory productIds = market.getProductsByBuyer(buyer);
        uint256[] memory disputeIds = market.getMyDisputes(buyer);

        return BuyerDashboard({
            commissions: _buildProductSummaries(productIds),
            disputes: dispute.getDisputesByParty(disputeIds)
        });
    }

    // ── 画师 Dashboard ────────────────────────────────────────
    // 返回：全平台开放委托 + 画师接受的委托 + 画师相关争议进度
    struct SellerDashboard {
        ProductSummary[] openCommissions;  // 全平台开放委托（供画师浏览接单）
        ProductSummary[] myCommissions;    // 画师已接受的委托
        DisputeManager.PartyDisputeView[] disputes;
    }

    function getSellerDashboard(address seller)
        external view returns (SellerDashboard memory)
    {
        uint256[] memory listedIds = market.getListedProducts();
        uint256[] memory myIds = market.getProductsBySeller(seller);
        uint256[] memory disputeIds = market.getMyDisputes(seller);

        return SellerDashboard({
            openCommissions: _buildProductSummaries(listedIds),
            myCommissions: _buildProductSummaries(myIds),
            disputes: dispute.getDisputesByParty(disputeIds)
        });
    }

    // ── 审核员 Dashboard ─────────────────────────────────────────
    struct ReviewerDashboard {
        DisputeManager.DisputeView[] disputes;
        uint256 totalEarnings;
    }

    function getReviewerDashboard(address reviewer)
        external view returns (ReviewerDashboard memory)
    {
        return ReviewerDashboard({
            disputes: dispute.getReviewerDisputeDetails(reviewer),
            totalEarnings: dispute.reviewerEarnings(reviewer)
        });
    }

    // ── 委托浏览（任何人，无需登录）─────────────────────────────
    function getStorefront() external view returns (ProductSummary[] memory) {
        uint256[] memory listedIds = market.getListedProducts();
        return _buildProductSummaries(listedIds);
    }

    // ── 内部工具 ─────────────────────────────────────────────────
    function _buildProductSummaries(uint256[] memory ids)
        internal view returns (ProductSummary[] memory)
    {
        ProductSummary[] memory result = new ProductSummary[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            ProductMarket.Product memory p = market.getProduct(ids[i]);
            result[i] = ProductSummary({
                id: p.id,
                seller: p.seller,
                buyer: p.buyer,
                ipfsHash: p.ipfsHash,
                deliveryIpfsHash: p.deliveryIpfsHash,
                price: p.price,
                listedAt: p.listedAt,
                status: uint8(p.status)
            });
        }
        return result;
    }
}
