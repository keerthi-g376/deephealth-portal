public class MultiModalityDiscount {

    // recursion guard
    private static Boolean hasAlreadyRun = false;

    private static final Id SMART_MAMMO_ID = '01tHu00000Xa331IAB'; 
    private static final Id DEEP_HEALTH_ID = '01tHu00000XZg4hIAD';

    public static void applyDiscount(List<QuoteLineItem> quoteLineItems) {
        if (hasAlreadyRun) {
            return; // prevent infinite loop
        }
        hasAlreadyRun = true;

        if (quoteLineItems == null || quoteLineItems.isEmpty()) {
            return;
        }

        // Collect Quote Ids
        Set<Id> quoteIds = new Set<Id>();
        for (QuoteLineItem qli : quoteLineItems) {
            if (qli.QuoteId != null) {
                quoteIds.add(qli.QuoteId);
            }
        }

        if (quoteIds.isEmpty()) {
            return;
        }

        // Fetch all QLIs for those Quotes
        List<QuoteLineItem> allQuoteLines = [
            SELECT Id, QuoteId, Product2Id, Discount
            FROM QuoteLineItem
            WHERE QuoteId IN :quoteIds
        ];

        Map<Id, List<QuoteLineItem>> quoteToLines = new Map<Id, List<QuoteLineItem>>();
        for (QuoteLineItem qli : allQuoteLines) {
            if (!quoteToLines.containsKey(qli.QuoteId)) {
                quoteToLines.put(qli.QuoteId, new List<QuoteLineItem>());
            }
            quoteToLines.get(qli.QuoteId).add(qli);
        }

        List<QuoteLineItem> toUpdate = new List<QuoteLineItem>();

        for (Id qId : quoteToLines.keySet()) {
            List<QuoteLineItem> lines = quoteToLines.get(qId);

            Boolean hasMammo = false;
            Boolean hasLung = false;

            for (QuoteLineItem line : lines) {
                if (line.Product2Id == SMART_MAMMO_ID) {
                    hasMammo = true;
                }
                if (line.Product2Id == DEEP_HEALTH_ID) {
                    hasLung = true;
                }
            }

            if (hasMammo && hasLung) {
                for (QuoteLineItem line : lines) {
                    if (line.Discount == null || line.Discount == 0) { 
                        line.Discount = 10; // apply discount only if not already set
                        toUpdate.add(line);
                    }
                }
            }
        }

        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }
}