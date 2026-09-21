public class QuoteTriggerHandler {
    
    // ⚡ Replace this with your actual GPO Pricebook Id
    private static final Id GPO_PRICEBOOK_ID = '01sHu000009HkN8IAK';

    // -------------------------
    // 1. Assign GPO Pricebook
    // -------------------------
    public static void assignGPOPricebook(List<Quote> newQuotes) {
        Set<Id> accIds = new Set<Id>();
        for (Quote q : newQuotes) {
            if (q.QuoteAccountId != null && q.Pricebook2Id == null) {
                accIds.add(q.QuoteAccountId);
            }
        }

        if (!accIds.isEmpty()) {
            Map<Id, Account> accMap = new Map<Id, Account>(
                [SELECT Id, GPO__c FROM Account WHERE Id IN :accIds]
            );

            for (Quote q : newQuotes) {
                Account acc = accMap.get(q.QuoteAccountId);
                if (acc != null && acc.GPO__c != null && q.Pricebook2Id == null) {
                    q.Pricebook2Id = GPO_PRICEBOOK_ID;
                }
            }
        }
    }

    // -------------------------
    // 2. Apply 12% GPO Discount
    // -------------------------
    public static void applyGPODiscount(Map<Id, Quote> newQuoteMap) {
        List<QuoteLineItem> qliToUpdate = new List<QuoteLineItem>();

        List<QuoteLineItem> qlis = [
            SELECT Id, QuoteId, Discount,
                   Quote.Pricebook2Id, Quote.QuoteAccountId
            FROM QuoteLineItem
            WHERE QuoteId IN :newQuoteMap.keySet()
        ];

        Set<Id> accIds = new Set<Id>();
        for (QuoteLineItem qli : qlis) {
            Quote relatedQuote = newQuoteMap.get(qli.QuoteId);
            if (relatedQuote.QuoteAccountId != null) {
                accIds.add(relatedQuote.QuoteAccountId);
            }
        }

        Map<Id, Account> accMap = new Map<Id, Account>(
            [SELECT Id, GPO__c FROM Account WHERE Id IN :accIds]
        );

        for (QuoteLineItem qli : qlis) {
            Quote relatedQuote = newQuoteMap.get(qli.QuoteId);
            Account acc = accMap.get(relatedQuote.QuoteAccountId);

            // ✅ Only apply discount if:
            // 1) Account has GPO__c filled
            // 2) Quote uses GPO Pricebook
            if (acc != null && acc.GPO__c != null 
                && relatedQuote.Pricebook2Id == GPO_PRICEBOOK_ID) {
                qli.Discount = 12;
                qliToUpdate.add(qli);
            }
        }

        if (!qliToUpdate.isEmpty()) {
            update qliToUpdate;
        }
    }
}