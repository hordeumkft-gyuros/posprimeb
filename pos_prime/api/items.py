import frappe
from pos_prime.api._utils import (
    get_product_bundle_items,
    get_bundle_availability,
    validate_pos_access,
)


def get_item_uom_details(item_code, stock_uom="", sales_uom=""):
    """Return all UOM conversions and the default sales conversion for one Item."""
    rows = frappe.get_all(
        "UOM Conversion Detail",
        filters={"parent": item_code, "parenttype": "Item"},
        fields=["uom", "conversion_factor"],
        order_by="idx asc",
    )

    conversions = [
        {
            "uom": row.uom,
            "conversion_factor": float(row.conversion_factor or 1),
        }
        for row in rows
    ]

    if stock_uom and not any(row["uom"] == stock_uom for row in conversions):
        conversions.insert(
            0,
            {
                "uom": stock_uom,
                "conversion_factor": 1,
            },
        )

    selected_sales_uom = sales_uom or stock_uom
    selected_sales_factor = 1

    for row in conversions:
        if row["uom"] == selected_sales_uom:
            selected_sales_factor = float(row["conversion_factor"] or 1)
            break

    return {
        "sales_uom": selected_sales_uom,
        "sales_conversion_factor": selected_sales_factor,
        "uom_conversions": conversions,
    }


def add_uom_details(item):
    """Attach POS display and selling-UOM data to one Item dict."""
    details = get_item_uom_details(
        item.get("item_code"),
        item.get("stock_uom") or "",
        item.get("sales_uom") or "",
    )

    item["sales_uom"] = details["sales_uom"]
    item["sales_conversion_factor"] = details["sales_conversion_factor"]
    item["uom_conversions"] = details["uom_conversions"]

    # The current business setup stores selling prices in the Stock UOM (m2).
    # The frontend converts this base rate to the selected sales UOM (Doboz).
    item["price_uom"] = item.get("stock_uom") or ""
    item["price_conversion_factor"] = 1
    return item


@frappe.whitelist()
def get_items(
    start=0,
    page_length=20,
    search_term="",
    item_group="",
    pos_profile="",
    hide_unavailable=None,
):
    """Get items for POS with stock quantities, prices, images and UOM data."""
    validate_pos_access(pos_profile or None)
    start = int(start)
    page_length = int(page_length)

    price_list = "Standard Selling"
    warehouse = ""
    profile_hide = False
    allowed_groups = []

    if pos_profile:
        profile = frappe.get_doc("POS Profile", pos_profile)
        price_list = profile.selling_price_list or "Standard Selling"
        warehouse = profile.warehouse or ""
        profile_hide = bool(profile.get("hide_unavailable_items"))

        if profile.item_groups:
            allowed_groups = [ig.item_group for ig in profile.item_groups]

    should_hide = hide_unavailable if hide_unavailable is not None else profile_hide

    group_filter_list = None
    if item_group:
        group_filter_list = _get_group_and_children(item_group)
    elif allowed_groups:
        all_groups = set()
        for group in allowed_groups:
            all_groups.update(_get_group_and_children(group))
        group_filter_list = list(all_groups) if all_groups else None

    conditions = [
        "i.disabled = 0",
        "i.is_sales_item = 1",
        "i.has_variants = 0",
        "i.is_fixed_asset = 0",
    ]
    values = {}

    if group_filter_list:
        conditions.append("i.item_group IN %(groups)s")
        values["groups"] = group_filter_list

    if search_term:
        conditions.append(
            "(i.item_name LIKE %(search)s OR i.item_code LIKE %(search)s "
            "OR i.description LIKE %(search)s)"
        )
        values["search"] = f"%{search_term}%"

    if should_hide and warehouse:
        join_clause = (
            "LEFT JOIN `tabBin` b ON b.item_code = i.item_code "
            "AND b.warehouse = %(warehouse)s "
            "LEFT JOIN ("
            "SELECT pi_item.item_code, SUM(pi_item.stock_qty) AS reserved_qty "
            "FROM `tabPOS Invoice Item` pi_item "
            "INNER JOIN `tabPOS Invoice` pi ON pi.name = pi_item.parent "
            "WHERE pi_item.docstatus = 1 "
            "AND pi_item.warehouse = %(warehouse)s "
            "AND IFNULL(pi.consolidated_invoice, '') = '' "
            "GROUP BY pi_item.item_code"
            ") pos_res ON pos_res.item_code = i.item_code"
        )
        conditions.append(
            "(i.is_stock_item = 0 OR "
            "(IFNULL(b.actual_qty, 0) - IFNULL(pos_res.reserved_qty, 0)) > 0)"
        )
        values["warehouse"] = warehouse
    else:
        join_clause = ""

    where = " AND ".join(conditions)

    items = frappe.db.sql(
        f"""
        SELECT
            i.item_code,
            i.item_name,
            i.description,
            i.item_group,
            i.stock_uom,
            i.sales_uom,
            i.image,
            i.has_batch_no,
            i.has_serial_no,
            i.is_stock_item,
            i.brand,
            i.weight_per_unit,
            i.weight_uom
        FROM `tabItem` i
        {join_clause}
        WHERE {where}
        ORDER BY i.item_name ASC
        LIMIT %(start)s, %(page_length)s
        """,
        {**values, "start": start, "page_length": page_length},
        as_dict=True,
    )

    if not items:
        return {"items": []}

    item_codes = [item.item_code for item in items]

    prices = {
        row.item_code: row.price_list_rate
        for row in frappe.get_all(
            "Item Price",
            filters={
                "item_code": ["in", item_codes],
                "price_list": price_list,
                "selling": 1,
            },
            fields=["item_code", "price_list_rate"],
        )
    }

    if warehouse:
        stock = {
            row.item_code: row.actual_qty
            for row in frappe.get_all(
                "Bin",
                filters={"item_code": ["in", item_codes], "warehouse": warehouse},
                fields=["item_code", "actual_qty"],
            )
        }
    else:
        stock_data = frappe.db.sql(
            "SELECT item_code, SUM(actual_qty) AS qty "
            "FROM `tabBin` WHERE item_code IN %s GROUP BY item_code",
            [item_codes],
            as_dict=True,
        )
        stock = {row.item_code: row.qty or 0 for row in stock_data}

    barcodes = {}
    for barcode in frappe.get_all(
        "Item Barcode",
        filters={"parent": ["in", item_codes]},
        fields=["parent", "barcode"],
        order_by="idx asc",
    ):
        barcodes.setdefault(barcode.parent, []).append(barcode.barcode)

    tax_templates = {}
    for tax in frappe.get_all(
        "Item Tax",
        filters={"parent": ["in", item_codes]},
        fields=["parent", "item_tax_template"],
        order_by="idx asc",
    ):
        if tax.parent not in tax_templates:
            tax_templates[tax.parent] = tax.item_tax_template

    reserved = {}
    if warehouse:
        reserved_data = frappe.db.sql(
            """
            SELECT pi_item.item_code, SUM(pi_item.stock_qty) AS qty
            FROM `tabPOS Invoice Item` pi_item
            INNER JOIN `tabPOS Invoice` pi ON pi.name = pi_item.parent
            WHERE pi_item.docstatus = 1
              AND pi_item.item_code IN %(item_codes)s
              AND pi_item.warehouse = %(warehouse)s
              AND IFNULL(pi.consolidated_invoice, '') = ''
            GROUP BY pi_item.item_code
            """,
            {"item_codes": item_codes, "warehouse": warehouse},
            as_dict=True,
        )
        reserved = {row.item_code: row.qty or 0 for row in reserved_data}

    bundle_rows = frappe.get_all(
        "Product Bundle",
        filters={"disabled": 0, "new_item_code": ["in", item_codes]},
        fields=["new_item_code"],
    )
    bundle_set = {bundle.new_item_code for bundle in bundle_rows}

    currency = frappe.defaults.get_defaults().get("currency", "USD")

    for item in items:
        item["rate"] = prices.get(item.item_code, 0)
        item["currency"] = currency
        item["barcodes"] = barcodes.get(item.item_code, [])
        item["barcode"] = item["barcodes"][0] if item["barcodes"] else None
        item["item_tax_template"] = tax_templates.get(item.item_code)

        if item.item_code in bundle_set:
            item["is_product_bundle"] = True
            item["actual_qty"] = (
                get_bundle_availability(item.item_code, warehouse)
                if warehouse
                else 0
            )
        else:
            item["is_product_bundle"] = False
            actual = stock.get(item.item_code, 0)
            item["actual_qty"] = max(actual - reserved.get(item.item_code, 0), 0)

        add_uom_details(item)

    return {"items": items}


def _get_group_and_children(item_group):
    """Return one Item Group and all of its descendants."""
    group_data = frappe.db.get_value("Item Group", item_group, ["lft", "rgt"])

    if not group_data:
        return [item_group]

    lft, rgt = group_data
    rows = frappe.db.sql(
        "SELECT name FROM `tabItem Group` WHERE lft >= %s AND rgt <= %s",
        (lft, rgt),
        as_list=True,
    )
    return [row[0] for row in rows]


@frappe.whitelist()
def get_item_tax_templates(company=""):
    """Get available Item Tax Templates, optionally filtered by Company."""
    validate_pos_access()
    filters = {}

    if company:
        filters["company"] = company

    return frappe.get_list(
        "Item Tax Template",
        filters=filters,
        fields=["name", "company"],
        order_by="name asc",
        limit_page_length=100,
    )


@frappe.whitelist()
def search_barcode(search_value, pos_profile=""):
    """Search by barcode, Item Code, Serial No or Batch No."""
    validate_pos_access(pos_profile or None)
    result = None

    barcode_data = frappe.get_all(
        "Item Barcode",
        filters={"barcode": search_value},
        fields=["parent as item_code", "barcode", "uom"],
        limit=1,
    )

    if barcode_data:
        item = frappe.db.get_value(
            "Item",
            barcode_data[0].item_code,
            [
                "item_code",
                "item_name",
                "stock_uom",
                "sales_uom",
                "image",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "item_group",
                "disabled",
                "has_variants",
            ],
            as_dict=True,
        )

        if item and not item.disabled and not item.has_variants:
            result = {**item, "barcode": search_value}

            barcode_uom = barcode_data[0].get("uom")
            if barcode_uom and barcode_uom != item.stock_uom:
                result["barcode_uom"] = barcode_uom

                uom_row = frappe.db.get_value(
                    "UOM Conversion Detail",
                    {"parent": item.item_code, "uom": barcode_uom},
                    "conversion_factor",
                )
                result["barcode_conversion_factor"] = uom_row or 1

    if not result:
        item = frappe.db.get_value(
            "Item",
            search_value,
            [
                "item_code",
                "item_name",
                "stock_uom",
                "sales_uom",
                "image",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "item_group",
                "disabled",
                "has_variants",
            ],
            as_dict=True,
        )

        if item and not item.disabled and not item.has_variants:
            result = {
                **item,
                "barcode": search_value,
            }

    if not result and frappe.db.exists("Serial No", search_value):
        serial_no = frappe.db.get_value(
            "Serial No",
            search_value,
            ["name", "item_code", "batch_no"],
            as_dict=True,
        )

        item = frappe.db.get_value(
            "Item",
            serial_no.item_code,
            [
                "item_name",
                "stock_uom",
                "sales_uom",
                "image",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "item_group",
                "disabled",
                "has_variants",
            ],
            as_dict=True,
        )

        if item and not item.disabled and not item.has_variants:
            result = {
                "item_code": serial_no.item_code,
                **item,
                "serial_no": serial_no.name,
                "batch_no": serial_no.batch_no,
                "barcode": search_value,
            }

    if not result and frappe.db.exists("Batch", search_value):
        batch = frappe.db.get_value(
            "Batch",
            search_value,
            ["name", "item"],
            as_dict=True,
        )

        item = frappe.db.get_value(
            "Item",
            batch.item,
            [
                "item_name",
                "stock_uom",
                "sales_uom",
                "image",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "item_group",
                "disabled",
                "has_variants",
            ],
            as_dict=True,
        )

        if item and not item.disabled and not item.has_variants:
            result = {
                "item_code": batch.item,
                **item,
                "batch_no": batch.name,
                "barcode": search_value,
            }

    if not result:
        return None

    price_list = "Standard Selling"
    if pos_profile:
        price_list = frappe.db.get_value(
            "POS Profile",
            pos_profile,
            "selling_price_list",
        ) or "Standard Selling"

    rate = frappe.db.get_value(
        "Item Price",
        {
            "item_code": result["item_code"],
            "price_list": price_list,
            "selling": 1,
        },
        "price_list_rate",
    )

    result["rate"] = rate or 0
    result["currency"] = frappe.defaults.get_defaults().get("currency", "USD")
    result["description"] = (
        frappe.db.get_value("Item", result["item_code"], "description") or ""
    )

    tax_template = frappe.get_all(
        "Item Tax",
        filters={"parent": result["item_code"]},
        fields=["item_tax_template"],
        order_by="idx asc",
        limit=1,
    )
    result["item_tax_template"] = (
        tax_template[0].item_tax_template if tax_template else None
    )

    warehouse = ""
    if pos_profile:
        warehouse = frappe.db.get_value(
            "POS Profile",
            pos_profile,
            "warehouse",
        ) or ""

    if warehouse:
        actual_qty = frappe.db.get_value(
            "Bin",
            {"item_code": result["item_code"], "warehouse": warehouse},
            "actual_qty",
        ) or 0

        reserved_qty = frappe.db.sql(
            """
            SELECT SUM(pi_item.stock_qty)
            FROM `tabPOS Invoice Item` pi_item
            INNER JOIN `tabPOS Invoice` pi ON pi.name = pi_item.parent
            WHERE pi_item.docstatus = 1
              AND pi_item.item_code = %s
              AND pi_item.warehouse = %s
              AND IFNULL(pi.consolidated_invoice, '') = ''
            """,
            (result["item_code"], warehouse),
        )

        reserved = (reserved_qty[0][0] or 0) if reserved_qty else 0
        result["actual_qty"] = max(actual_qty - reserved, 0)
    else:
        result["actual_qty"] = 0

    if get_product_bundle_items(result["item_code"]):
        result["is_product_bundle"] = True
        if warehouse:
            result["actual_qty"] = get_bundle_availability(
                result["item_code"],
                warehouse,
            )
    else:
        result["is_product_bundle"] = False

    add_uom_details(result)
    return result


@frappe.whitelist()
def get_item_groups(pos_profile=""):
    """Get Item Groups, filtered by POS Profile when configured."""
    validate_pos_access(pos_profile or None)

    if pos_profile:
        profile = frappe.get_doc("POS Profile", pos_profile)
        if profile.item_groups:
            return [item_group.item_group for item_group in profile.item_groups]

    groups = frappe.get_list(
        "Item Group",
        filters={"is_group": 0},
        fields=["name"],
        order_by="name asc",
        limit_page_length=50,
    )
    return [group.name for group in groups]
