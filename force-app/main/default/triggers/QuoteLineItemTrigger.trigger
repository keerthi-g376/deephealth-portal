trigger QuoteLineItemTrigger on QuoteLineItem (after insert, after update) {
    MultiModalityDiscount.applyDiscount(Trigger.new);
}