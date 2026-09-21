public with sharing class QuoteApprovalLWCController {
    @AuraEnabled
    public static void submitQuoteForApproval(Id quoteId, String submitterComments) {
        String flowApiName = 'Approval_Workflow';
        Map<String, Object> inputs = new Map<String, Object>();
        inputs.put('recordId', quoteId);
        inputs.put('submitter', UserInfo.getUserId());
        inputs.put('submissionComments', submitterComments);
        Flow.Interview myFlow = Flow.Interview.createInterview(flowApiName, inputs);
        myFlow.start();
    }
}