-- 0014_target_vehicle_write_once.sql — the deal's make/model are write-once.
--
-- specs/00-shared-core-architecture.md "Cardinality invariants (structurally
-- enforced)": "`target_vehicle.make`/`model` are write-once — settable while
-- the deal is `draft`, immutable once any offer is attached."
-- decisions/OPEN-QUESTIONS.md Q11 (AMENDED). docs/design/T-016.md §3.3, §5.2.
--
-- Last migration because the predicate READS `offers` and `dealer_threads`,
-- which do not exist before 0007/0008.
--
-- The three disjuncts below are @core `isTargetVehicleLocked`'s three
-- disjuncts, in the same order:
--     deal.status !== 'draft'
--  || deal.offers.length > 0
--  || deal.dealer_threads.some((t) => t.current_offer !== undefined)
-- One predicate, two enforcement sites. The drift this guards against is the
-- API saying "locked" while the schema says "fine", which would let the
-- one-vehicle anchor rot from the inside; the DB suite runs one shared case
-- table through both and asserts they agree row for row.
--
-- SQLSTATE DC002 (design D6) is the write-once class. T-020 renders the spec's
-- UX on it: reject the entry, highlight the vehicle against its VIN, offer a
-- new deal — and record the rejection as a receipt event, which is a SEPARATE
-- insert outside the aborted transaction.

CREATE FUNCTION deals_target_vehicle_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.target_make  IS DISTINCT FROM OLD.target_make
    OR NEW.target_model IS DISTINCT FROM OLD.target_model THEN
      IF OLD.status <> 'draft'
      OR EXISTS (SELECT 1 FROM offers o WHERE o.deal_id = OLD.id)
      OR EXISTS (SELECT 1 FROM dealer_threads t
                  WHERE t.deal_id = OLD.id AND t.current_offer_id IS NOT NULL) THEN
        RAISE EXCEPTION
          'deal % target make/model is write-once once the deal has left draft or any offer is attached',
          OLD.id
          USING ERRCODE = 'DC002', TABLE = 'deals', COLUMN = 'target_make';
      END IF;
    END IF;
    RETURN NEW;
  END;
$$;

CREATE TRIGGER deals_target_vehicle_write_once
  BEFORE UPDATE ON deals FOR EACH ROW
  EXECUTE FUNCTION deals_target_vehicle_write_once();
