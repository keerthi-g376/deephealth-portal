public class ProductDiscoveryAdditionalContextData {
    // This class is used to hold input parameters
    public class FlowInput{
        @invocableVariable(required=false)
        public String objectApiName;
        @invocableVariable(required=false)
        public String recordId;
    }
    // This class is used to hold output parameters
    public class FlowOutput{
        @invocableVariable
        public runtime_industries_cpq.ContextDataInput[] additionalContextData;
    }
    // This method can be called from a Flow
    @invocableMethod(label='Generate JSON' description='Generates additional Context data JSON for Quote node')
    public static List<FlowOutput> generateJSON(List<FlowInput> inputs){
        String apiName;
        String recId;
        FlowOutput output = new FlowOutput();
        // Create a list to hold results
        System.debug('Log Input :' + inputs);
        for(FlowInput input: inputs){
            apiName = input.objectApiName;
            recId = input.recordId;
        }
        List<runtime_industries_cpq.ContextDataInput> lstAdditionalContextData = new List<runtime_industries_cpq.ContextDataInput>();
        runtime_industries_cpq.ContextDataInput contextData = new runtime_industries_cpq.ContextDataInput();
        contextData.nodeName = apiName;
        contextData.nodeData = new Map<String, Object>();
        contextData.nodeData.put('id', recId);
        lstAdditionalContextData.add(contextData);
        output.additionalContextData = lstAdditionalContextData;
        List<FlowOutput> outputs = new List<FlowOutput>();
        outputs.add(output);
        return outputs;
    }
}