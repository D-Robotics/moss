// Free-shipping threshold check. Orders at exactly the threshold get free
// shipping (>=), below it pay.
export function qualifiesForFreeShipping(subtotalCents) {
  return subtotalCents >= 5000;
}
