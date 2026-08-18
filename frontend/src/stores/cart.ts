// Copyright (c) 2026, Ravindu Gajanayaka
// Licensed under GPLv3. See license.txt

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { call } from 'frappe-ui'
import type { CartItem, Item, TaxRow, InvoiceOptions } from '@/types'

let taxRequestId = 0

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function getStockQty(item: Pick<CartItem, 'qty' | 'conversion_factor'>) {
  return item.qty * (item.conversion_factor || 1)
}

export const useCartStore = defineStore('cart', () => {
  const items = ref<CartItem[]>([])
  const selectedItemIndex = ref<number | null>(null)

  // Server-side tax data
  const taxes = ref<TaxRow[]>([])
  const serverNetTotal = ref<number | null>(null)
  const serverGrandTotal = ref<number | null>(null)
  const serverRoundedTotal = ref<number | null>(null)
  const serverRoundingAdjustment = ref<number>(0)
  const serverTotalTaxesAndCharges = ref<number>(0)

  // Invoice-level discount
  const discountType = ref<'percentage' | 'amount'>('percentage')
  const discountValue = ref(0)
  const applyDiscountOn = ref<'Grand Total' | 'Net Total'>('Grand Total')

  // Coupon code
  const couponCode = ref<string | null>(null)

  // Invoice-level optional fields
  const invoiceOptions = ref<InvoiceOptions>({})

  // Pricing-rule-applied transaction discount (from server)
  const pricingRuleDiscount = ref<{ type: 'percentage' | 'amount'; value: number } | null>(null)

  // Tax calculation state
  const taxCalculating = ref(false)
  const error = ref<string | null>(null)
  let taxDebounceTimer: ReturnType<typeof setTimeout> | null = null

  const subtotal = computed(() =>
    items.value.reduce((sum, item) => sum + item.amount, 0)
  )

  const additionalDiscountPercentage = computed(() =>
    discountType.value === 'percentage' ? discountValue.value : 0
  )

  const additionalDiscountAmount = computed(() =>
    discountType.value === 'amount' ? discountValue.value : 0
  )

  const netTotal = computed(() => serverNetTotal.value ?? subtotal.value)

  const taxAmount = computed(() => serverTotalTaxesAndCharges.value)

  const grandTotal = computed(() =>
    serverGrandTotal.value ?? subtotal.value
  )

  const roundedTotal = computed(() => serverRoundedTotal.value ?? grandTotal.value)

  const totalItems = computed(() =>
    items.value.reduce((sum, item) => sum + item.qty, 0)
  )

  function addItem(item: Item, validateStock = true): string | null {
  const salesFactor = item.sales_conversion_factor || 1

  if (validateStock && item.is_stock_item) {
    const available = item.actual_qty ?? 0

    const existingStockQty = items.value
      .filter((cartItem) => cartItem.item_code === item.item_code)
      .reduce((sum, cartItem) => sum + getStockQty(cartItem), 0)

    const requiredStockQty = existingStockQty + salesFactor

    if (requiredStockQty > available) {
      return __('Not enough stock. Available: {0}', [String(available)])
    }
  }

  if (item.has_batch_no || item.has_serial_no) {
    items.value.push(createCartItem(item))
    selectedItemIndex.value = items.value.length - 1
    debounceTaxCalculation()
    return null
  }

  const existingIndex = items.value.findIndex(
    (cartItem) =>
      cartItem.item_code === item.item_code &&
      !cartItem.batch_no &&
      !cartItem.serial_no
  )

  if (existingIndex >= 0) {
    const cartItem = items.value[existingIndex]
    const available = cartItem.available_qty ?? item.actual_qty ?? 0
    const requestedStockQty = getStockQty(cartItem) + (cartItem.conversion_factor || 1)

    if (validateStock && cartItem.is_free_item !== true && requestedStockQty > available) {
      return __('Not enough stock. Available: {0}', [String(available)])
    }

    cartItem.qty += 1
    recalcItemAmount(existingIndex)
    selectedItemIndex.value = existingIndex
  } else {
    items.value.push(createCartItem(item))
    selectedItemIndex.value = items.value.length - 1
  }

  debounceTaxCalculation()
  return null
}

  function createCartItem(item: Item): CartItem {
  const conversionFactor = item.sales_conversion_factor || 1
  const salesUom = item.sales_uom || item.stock_uom
  const baseRate = item.rate || 0

  // A jelenlegi árlista m²-alapú, ezért a Doboz ára:
  // Ft/doboz = Ft/m² × m²/doboz
  const salesRate = roundMoney(baseRate * conversionFactor)

  return {
    item_code: item.item_code,
    item_name: item.item_name,
    rate: salesRate,
    base_rate: baseRate,
    price_conversion_factor: item.price_conversion_factor || 1,
    qty: 1,
    amount: salesRate,
    uom: salesUom,
    discount_percentage: 0,
    discount_amount: 0,
    image: item.image,
    stock_uom: item.stock_uom,
    available_qty: item.actual_qty,
    has_serial_no: item.has_serial_no,
    has_batch_no: item.has_batch_no,
    serial_no: null,
    batch_no: null,
    serial_and_batch_bundle: null,
    conversion_factor: conversionFactor,
    item_tax_template: item.item_tax_template || null,
    margin_type: null,
    margin_rate_or_amount: 0,
    description: item.description || null,
    project: null,
    weight_per_unit: item.weight_per_unit || null,
    weight_uom: item.weight_uom || null,
  }
}
  function updateQty(index: number, qty: number, availableQty?: number, validateStock = true): string | null {
  if (qty <= 0) {
    removeItem(index)
    return null
  }

  const item = items.value[index]
  if (!item) return null

  const available = availableQty ?? item.available_qty

  if (validateStock && available !== undefined && item.is_stock_item !== false) {
    const otherCartStockQty = items.value
      .filter((cartItem, rowIndex) =>
        rowIndex !== index && cartItem.item_code === item.item_code
      )
      .reduce((sum, cartItem) => sum + getStockQty(cartItem), 0)

    const requestedStockQty = qty * (item.conversion_factor || 1)

    if (otherCartStockQty + requestedStockQty > available) {
      return __('Not enough stock. Available: {0}', [String(available)])
    }
  }

  item.qty = qty
  recalcItemAmount(index)
  debounceTaxCalculation()
  return null
}

  function updateRate(index: number, rate: number) {
    items.value[index].rate = rate
    recalcItemAmount(index)
    debounceTaxCalculation()
  }

  function updateItemDiscount(index: number, discount: number) {
    items.value[index].discount_percentage = Math.min(Math.max(discount, 0), 100)
    // User override clears pricing rule (server will re-evaluate)
    items.value[index].pricing_rules = null
    items.value[index].price_list_rate = null
    recalcItemAmount(index)
    debounceTaxCalculation()
  }

  function updateItemBatchSerial(
    index: number,
    batch_no: string | null,
    serial_no: string | null
  ) {
    items.value[index].batch_no = batch_no
    items.value[index].serial_no = serial_no
  }

  function updateItemUom(index: number, uom: string, conversionFactor: number) {
  const item = items.value[index]
  if (!item || conversionFactor <= 0) return

  item.uom = uom
  item.conversion_factor = conversionFactor

  // UOM-váltáskor az egységár is változik.
  // Példa: 9 990 Ft/m² × 1,23 = 12 287,70 Ft/Doboz.
  item.rate = roundMoney(
    (item.base_rate || item.rate) *
    conversionFactor /
    (item.price_conversion_factor || 1)
  )

  recalcItemAmount(index)
  debounceTaxCalculation()
}

  function updateItemDiscountAmount(index: number, discountAmt: number) {
    items.value[index].discount_amount = Math.max(discountAmt, 0)
    items.value[index].discount_percentage = 0 // clear % when using flat
    // User override clears pricing rule (server will re-evaluate)
    items.value[index].pricing_rules = null
    items.value[index].price_list_rate = null
    recalcItemAmount(index)
    debounceTaxCalculation()
  }

  function updateItemTaxTemplate(index: number, template: string | null) {
    items.value[index].item_tax_template = template
    debounceTaxCalculation()
  }

  function setInvoiceOptions(options: Partial<InvoiceOptions>) {
    invoiceOptions.value = { ...invoiceOptions.value, ...options }
  }

  function recalcItemAmount(index: number) {
    const item = items.value[index]
    if (item.pricing_rules) {
      // Rate is already the final discounted rate from the pricing engine;
      // discount_percentage/discount_amount are kept for display only.
      item.amount = item.qty * item.rate
    } else if (item.discount_amount > 0) {
      // discount_amount is total line discount (not per-unit), matching ERPNext behavior
      item.amount = Math.max(0, item.qty * item.rate - item.discount_amount)
    } else {
      item.amount = item.qty * item.rate * (1 - item.discount_percentage / 100)
    }
    // Round to 2 decimal places to avoid floating point precision issues
    item.amount = Math.round(item.amount * 100) / 100
  }

  function removeItem(index: number) {
    items.value.splice(index, 1)
    if (selectedItemIndex.value === index) {
      selectedItemIndex.value = null
    } else if (
      selectedItemIndex.value !== null &&
      selectedItemIndex.value > index
    ) {
      selectedItemIndex.value -= 1
    }
    debounceTaxCalculation()
  }

  function selectItem(index: number | null) {
    selectedItemIndex.value = index
  }

  function setDiscount(type: 'percentage' | 'amount', value: number) {
    discountType.value = type
    discountValue.value = value
    debounceTaxCalculation()
  }

  function setCouponCode(code: string | null) {
    couponCode.value = code
    debounceTaxCalculation()
  }

  function debounceTaxCalculation() {
    if (taxDebounceTimer) clearTimeout(taxDebounceTimer)
    taxDebounceTimer = setTimeout(() => {
      calculateTaxes()
    }, 500)
  }

  async function calculateTaxes(posProfile?: string, customer?: string) {
    if (items.value.length === 0) {
      clearTaxData()
      return
    }

    // Import settings & customer stores lazily to avoid circular deps
    const { useSettingsStore } = await import('@/stores/settings')
    const { useCustomerStore } = await import('@/stores/customer')
    const { usePosSessionStore } = await import('@/stores/posSession')

    const settings = useSettingsStore()
    const customerStore = useCustomerStore()
    const sessionStore = usePosSessionStore()

    const profile = posProfile || sessionStore.posProfile
    const cust = customer || customerStore.customer?.name || settings.posProfile?.customer

    if (!profile || !cust) {
      clearTaxData()
      return
    }

    const currentId = ++taxRequestId
    taxCalculating.value = true
    try {
      const data = await call('pos_prime.api.taxes.calculate_taxes', {
        pos_profile: profile,
        customer: cust,
        items: items.value.map((item) => ({
          item_code: item.item_code,
          qty: item.qty,
          rate: item.rate,
          discount_percentage: item.discount_percentage,
          discount_amount: item.discount_amount || 0,
          serial_no: item.serial_no || '',
          batch_no: item.batch_no || '',
          uom: item.uom || '',
          conversion_factor: item.conversion_factor || 1,
          item_tax_template: item.item_tax_template || '',
          margin_type: item.margin_type || '',
          margin_rate_or_amount: item.margin_rate_or_amount || 0,
        })),
        additional_discount_percentage: additionalDiscountPercentage.value,
        discount_amount: additionalDiscountAmount.value,
        apply_discount_on: applyDiscountOn.value,
        coupon_code: couponCode.value || undefined,
      })

      if (currentId !== taxRequestId) return

      taxes.value = data.taxes || []
      serverNetTotal.value = data.net_total
      serverGrandTotal.value = data.grand_total
      serverRoundedTotal.value = data.rounded_total
      serverRoundingAdjustment.value = data.rounding_adjustment || 0
      serverTotalTaxesAndCharges.value = data.total_taxes_and_charges || 0

      // Apply pricing rule data to cart items
      applyPricingRuleData(data.pricing_rules || [], data.free_items || [])

      // Track apply_discount_on from server (pricing rules may override)
      if (data.apply_discount_on) {
        applyDiscountOn.value = data.apply_discount_on
      }

      // Detect transaction-level pricing rule discount
      const serverDiscPct = data.additional_discount_percentage || 0
      const serverDiscAmt = data.discount_amount || 0
      const sentDiscPct = additionalDiscountPercentage.value
      const sentDiscAmt = additionalDiscountAmount.value
      if (serverDiscPct > sentDiscPct) {
        pricingRuleDiscount.value = { type: 'percentage', value: serverDiscPct }
      } else if (serverDiscAmt > sentDiscAmt) {
        pricingRuleDiscount.value = { type: 'amount', value: serverDiscAmt }
      } else {
        pricingRuleDiscount.value = null
      }
    } catch {
      if (currentId !== taxRequestId) return
      error.value = 'Tax calculation failed'
      clearTaxData()
    } finally {
      if (currentId === taxRequestId) {
        taxCalculating.value = false
      }
    }
  }

  function applyPricingRuleData(
    pricingRules: { item_code: string; pricing_rules: string; rate: number; price_list_rate: number; discount_percentage: number; discount_amount: number }[],
    freeItems: { item_code: string; item_name: string; qty: number; rate: number; amount: number; uom: string; stock_uom: string; pricing_rules: string }[],
  ) {
    // Clear previous pricing rule markers from non-free items
    for (const item of items.value) {
      if (!item.is_free_item) {
        item.pricing_rules = null
        item.price_list_rate = null
      }
    }

    // Remove old free items (they'll be re-added from fresh data)
    items.value = items.value.filter((i) => !i.is_free_item)

    // Apply pricing rule info to matching cart items
    for (const pr of pricingRules) {
      const cartItem = items.value.find((i) => i.item_code === pr.item_code && !i.is_free_item)
      if (cartItem) {
        cartItem.pricing_rules = pr.pricing_rules
        cartItem.price_list_rate = pr.price_list_rate
        // Update rate from pricing rule (the server returns the final discounted rate)
        if (pr.rate > 0 && pr.rate !== cartItem.rate) {
          cartItem.rate = pr.rate
        }
        // Update discount fields from pricing rule
        if (pr.discount_percentage > 0) {
          cartItem.discount_percentage = pr.discount_percentage
        }
        if (pr.discount_amount > 0) {
          cartItem.discount_amount = pr.discount_amount
        }
        recalcItemAmount(items.value.indexOf(cartItem))
      }
    }

    // Add free items from Buy X Get Y rules
    for (const fi of freeItems) {
      items.value.push({
        item_code: fi.item_code,
        item_name: fi.item_name,
        rate: fi.rate || 0,
        qty: fi.qty,
        amount: fi.amount || 0,
        uom: fi.uom || fi.stock_uom || '',
        discount_percentage: 0,
        discount_amount: 0,
        image: null,
        stock_uom: fi.stock_uom || fi.uom || '',
        has_serial_no: false,
        has_batch_no: false,
        serial_no: null,
        batch_no: null,
        serial_and_batch_bundle: null,
        conversion_factor: 1,
        item_tax_template: null,
        margin_type: null,
        margin_rate_or_amount: 0,
        description: null,
        project: null,
        weight_per_unit: null,
        weight_uom: null,
        is_free_item: true,
        pricing_rules: fi.pricing_rules || null,
        price_list_rate: null,
      })
    }
  }

  function clearTaxData() {
    taxes.value = []
    serverNetTotal.value = null
    serverGrandTotal.value = null
    serverRoundedTotal.value = null
    serverRoundingAdjustment.value = 0
    serverTotalTaxesAndCharges.value = 0
    pricingRuleDiscount.value = null
  }

  function $reset() {
    items.value = []
    selectedItemIndex.value = null
    discountType.value = 'percentage'
    discountValue.value = 0
    applyDiscountOn.value = 'Grand Total'
    couponCode.value = null
    invoiceOptions.value = {}
    taxCalculating.value = false
    error.value = null
    if (taxDebounceTimer) {
      clearTimeout(taxDebounceTimer)
      taxDebounceTimer = null
    }
    taxRequestId++
    clearTaxData()
  }

  return {
    items,
    selectedItemIndex,
    taxes,
    taxCalculating,
    discountType,
    discountValue,
    couponCode,
    applyDiscountOn,
    invoiceOptions,
    subtotal,
    additionalDiscountPercentage,
    additionalDiscountAmount,
    netTotal,
    taxAmount,
    grandTotal,
    roundedTotal,
    serverRoundingAdjustment,
    totalItems,
    addItem,
    updateQty,
    updateRate,
    updateItemDiscount,
    updateItemDiscountAmount,
    pricingRuleDiscount,
    updateItemTaxTemplate,
    updateItemBatchSerial,
    updateItemUom,
    removeItem,
    selectItem,
    setDiscount,
    setCouponCode,
    setInvoiceOptions,
    error,
    calculateTaxes,
    $reset,
  }
})
