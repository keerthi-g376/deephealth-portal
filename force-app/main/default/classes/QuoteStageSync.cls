/**
 * Keeps the Opportunity stage in step with the Quote status when the customer acts in the portal.
 *   Draft / Needs Review / In Review     -> Proposal/Price Quote
 *   Approved / Presented                 -> Negotiation/Review
 *   Accepted                             -> Closed Won
 *   Denied (customer not interested)     -> Closed Lost
 * Other statuses (Rejected, Superseded) leave the Opportunity alone, and a closed Opportunity is never changed.
 * Called from QuoteRestController after the status change - not from a Quote trigger, because Salesforce
 * does not allow the Opportunity to be updated from inside the Quote trigger or a job it starts.
 */
public with sharing class QuoteStageSync {
    private static final Map<String, String> STAGE_FOR_STATUS = new Map<String, String>{
        'Draft' => 'Proposal/Price Quote',
        'Needs Review' => 'Proposal/Price Quote',
        'In Review' => 'Proposal/Price Quote',
        'Approved' => 'Negotiation/Review',
        'Presented' => 'Negotiation/Review',
        'Accepted' => 'Closed Won',
        'Denied' => 'Closed Lost'
    };

    public static void apply(Id quoteId) {
        Quote q = [SELECT Status, OpportunityId FROM Quote WHERE Id = :quoteId LIMIT 1];
        String stage = STAGE_FOR_STATUS.get(q.Status);
        if (stage == null || q.OpportunityId == null) return;

        List<Opportunity> opps = [SELECT Id, StageName FROM Opportunity WHERE Id = :q.OpportunityId AND IsClosed = false];
        if (opps.isEmpty() || opps[0].StageName == stage) return;
        opps[0].StageName = stage;
        if (stage.startsWith('Closed')) opps[0].CloseDate = Date.today();
        update opps[0];
    }
}
