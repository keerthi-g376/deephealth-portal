public class TrueUpBatch implements Database.Batchable<sObject> {

    public Database.QueryLocator start(Database.BatchableContext bc) {
        // Query for contracts where the end date is today or in the past
        // and the contract is not yet processed for true-up
        return Database.getQueryLocator([
            SELECT Id, ContractNumber, StartDate, EndDate,RenewalTerm2, SourceQuoteId, AccountId, Status
       FROM Contract
    WHERE StartDate = tODAY
 //AND SBQQ__ContractingMethod__c = 'On Order Activation' // Example filter
            //WHERE Id = '800fk000002VpzgAAC'
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Contract> contracts) {
        List<Quote> quotesToInsert = new List<Quote>();
        List<QuoteLineItem> overageLinesToInsert = new List<QuoteLineItem>();

        // Loop through each contract to calculate overage
        for (Contract contract : contracts) {
            // Get the contract's original quote and its contracted quantity
            Quote originalQuote = [
                SELECT Id,AccountId,QuoteAccountId,Pricebook2Id, OpportunityId
                FROM Quote
                WHERE ContractId = :contract.Id
                LIMIT 1
            ];

            // Get the actual usage from the Usage Summary records
            AggregateResult ar = [
                SELECT SUM(Number_of_Studies__c) totalUsage
                FROM Usage_Summary__c
                WHERE Contract__c = :contract.Id
            ];
            Decimal totalUsage = (Decimal)ar.get('totalUsage');

            // Get the DeepHealth Lung AI product (assumed product ID for this example)
            Product2 lungAIProduct = [SELECT Id, OverageRate__c 
                                      FROM Product2 WHERE ProductCode = 'DH-LUNG-BLOCK-SUB' LIMIT 1];
            Decimal overageRate = lungAIProduct.OverageRate__c;

            // Check for overage
            System.debug('check for overage');
            if (totalUsage > 50000) { // Using 25000 as our contracted quantity
                System.debug('>50000');
                Decimal overage = totalUsage - 50000;
                Decimal overagePrice = overage * overageRate; // Using 10 as our overage rate

                // Create a new quote for the overage
                Quote overageQuote = new Quote(
                    Name = 'Overage Quote for '+ Account.Name,
                    QuoteAccountId = contract.AccountId,
                    OpportunityId = originalQuote.OpportunityId,
                    Pricebook2Id = originalQuote.Pricebook2Id,
                    Status = 'Draft',
                    ExpirationDate = Date.today().addDays(30)
                );
                quotesToInsert.add(overageQuote);

                // Create a new quote line for the overage
                QuoteLineItem overageLine = new QuoteLineItem(
                    QuoteId = overageQuote.Id,
                    Product2Id = lungAIProduct.Id,
                    BillingFrequency = 'Annual',
                    PricebookEntryId = '01uHu00000cxN8iIAE',
                    Quantity = overage,
                    Custom_List_Price__c = overageRate,
                    UnitPrice= overageRate,
                    SubscriptionTerm = 12
                );
                overageLinesToInsert.add(overageLine);
            }
        }
// DML operations
        if (!quotesToInsert.isEmpty()) {
            insert quotesToInsert;
            for (Integer i = 0; i < quotesToInsert.size(); i++) {
                overageLinesToInsert[i].QuoteId = quotesToInsert[i].Id;
            }
            insert overageLinesToInsert;
        }
    }

    public void finish(Database.BatchableContext bc) {
        // Can send an email notification here
    }
}