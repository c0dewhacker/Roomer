-- Drop the dead "equipment checkout" AssetAssignment model — no UI ever
-- reads or writes it (see issue #201). Superseded by AssetUserAssignment
-- (permanent desk/asset assignment), which drives Asset.bookingStatus and is
-- the only assignment mechanism reachable from the product.
DROP TABLE "AssetAssignment";
