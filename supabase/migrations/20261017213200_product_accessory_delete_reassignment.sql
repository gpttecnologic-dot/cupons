CREATE OR REPLACE FUNCTION public.reassign_accessory_parent_before_product_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE replacement_product uuid;
BEGIN
  IF OLD.product_type = 'product' THEN
    FOR replacement_product IN
      SELECT DISTINCT link.accessory_id
      FROM public.product_accessory_links link
      JOIN public.products accessory ON accessory.id = link.accessory_id
      WHERE link.product_id = OLD.id AND accessory.parent_product_id = OLD.id
    LOOP
      UPDATE public.products accessory
      SET parent_product_id = (
        SELECT link2.product_id
        FROM public.product_accessory_links link2
        JOIN public.products other_product ON other_product.id = link2.product_id
        WHERE link2.accessory_id = replacement_product AND link2.product_id <> OLD.id
        ORDER BY link2.created_at, link2.product_id
        LIMIT 1
      )
      WHERE accessory.id = replacement_product
        AND EXISTS (SELECT 1 FROM public.product_accessory_links x WHERE x.accessory_id = replacement_product AND x.product_id <> OLD.id);
    END LOOP;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS reassign_accessory_parent_before_product_delete_trigger ON public.products;
CREATE TRIGGER reassign_accessory_parent_before_product_delete_trigger
BEFORE DELETE ON public.products FOR EACH ROW EXECUTE FUNCTION public.reassign_accessory_parent_before_product_delete();