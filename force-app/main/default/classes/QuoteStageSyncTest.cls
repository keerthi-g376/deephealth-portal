@IsTest
private class QuoteStageSyncTest {
    private static Quote quoteOnOpportunity(String stage) {
        Account a = new Account(Name = 'Acme');
        insert a;
        Opportunity o = new Opportunity(Name = 'o', AccountId = a.Id, StageName = stage, CloseDate = Date.today().addDays(10));
        insert o;
        Quote q = new Quote(Name = 'q', OpportunityId = o.Id);
        insert q;
        return q;
    }

    private static String stageAfter(Quote q, String status) {
        q.Status = status;
        update q;
        QuoteStageSync.apply(q.Id);
        return [SELECT StageName FROM Opportunity WHERE Id = :q.OpportunityId].StageName;
    }

    @IsTest
    static void needsReviewMovesToProposal() {
        System.assertEquals('Proposal/Price Quote', stageAfter(quoteOnOpportunity('Prospecting'), 'Needs Review'));
    }

    @IsTest
    static void approvedMovesToNegotiation() {
        System.assertEquals('Negotiation/Review', stageAfter(quoteOnOpportunity('Prospecting'), 'Approved'));
    }

    @IsTest
    static void acceptedClosesWon() {
        Quote q = quoteOnOpportunity('Prospecting');
        System.assertEquals('Closed Won', stageAfter(q, 'Accepted'));
        System.assertEquals(Date.today(), [SELECT CloseDate FROM Opportunity WHERE Id = :q.OpportunityId].CloseDate);
    }

    @IsTest
    static void deniedClosesLost() {
        System.assertEquals('Closed Lost', stageAfter(quoteOnOpportunity('Prospecting'), 'Denied'));
    }

    @IsTest
    static void supersededLeavesTheStageAlone() {
        System.assertEquals('Negotiation/Review', stageAfter(quoteOnOpportunity('Negotiation/Review'), 'Superseded'));
    }

    @IsTest
    static void closedOpportunityIsNotReopened() {
        System.assertEquals('Closed Won', stageAfter(quoteOnOpportunity('Closed Won'), 'Approved'));
    }
}
