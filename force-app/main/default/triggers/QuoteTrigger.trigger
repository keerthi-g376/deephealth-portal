trigger QuoteTrigger on Quote (before insert, after insert, after update) {
    if (Trigger.isBefore) {
        if (Trigger.isInsert) {
            QuoteTriggerHandler.assignGPOPricebook(Trigger.new);
        }
    }

    if (Trigger.isAfter) {
        if (Trigger.isInsert || Trigger.isUpdate) {
            QuoteTriggerHandler.applyGPODiscount(Trigger.newMap);
        }
    }
}