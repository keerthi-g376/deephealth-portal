public class QuoteApprovalController {
    private Id quoteId;
    private String userId;
    public String submitterComments { get; set; }
   
    public QuoteApprovalController(ApexPages.StandardController controller) {
        Quote quote = (Quote) controller.getRecord();
        quoteId = quote.Id;
        userId = UserInfo.getUserId();
    }
    
    public void submitQuoteForApproval() {
        String flowApiName = 'Approval_Workflow';
        Map<String, Object> inputs = new Map<String, Object>();
        inputs.put('recordId', quoteId);
        inputs.put('submitter', userId);
        inputs.put('submissionComments', submitterComments);
        Flow.Interview myFlow = Flow.Interview.createInterview(flowApiName, inputs);
        myFlow.start();
    }
}