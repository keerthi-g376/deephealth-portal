/*
 * Copyright 2023 salesforce.com, inc.
 * All Rights Reserved
 * Company Confidential
 */
global with sharing class LogisticsSystemAdapter implements industriesintegrationfwk.ProcessIntegrationProviderAdvanced {
    
    private static final String MOCK_CALLOUT_NAMED_CREDENTIAL = 'callout:LogisticsSystemNC';
    private final static Integer TIMEOUT = 10000; // Request time out in milliseconds
        
    
    /**
     * @param requestGuid                 Request GUID provided by the client
     * @param inputRecordId               Input Record ID provided by the client
     * @param payload                     Payload to be passed to the Provider Class
     * @param attributes                  Map of config attributes
     * @return IntegrationCalloutResponse Response sent to the client
    */
      global static industriesintegrationfwk.IntegrationCalloutResponse executeCallout(String requestGuid, String inputRecordId, String payload, Map<String, Object> attributes, 
    industriesintegrationfwk.HttpBaseProvider httpProvider) {
        String msgBody = '{\"message\":\"Placed Order to Logistics\",' 
            + '\n\"requestGuid\":\"' + requestGuid + '\",\n'
            + '\n\"inputRecordId\":\"' + inputRecordId + '\",\n'
            + '\n\"payload\":\"' + payload + '\"}'            
            ;
        // Call endPoint
        HttpResponse response = makeCallout(httpProvider, msgBody);
        
        // Group response by groupId 
        //Map<String, Object> responseGroup = getResponseGroupAfterCallout(response);

        // Create IntegrationCalloutResponse Response - SUCCESS
        industriesintegrationfwk.IntegrationCalloutResponse integrationCalloutResponse = new industriesintegrationfwk.IntegrationCalloutResponse(false);
        integrationCalloutResponse.setResponseCode(408);
        integrationCalloutResponse.setErrorMessage('Request to Logistics system is timed out after 10 seconds');
        
        saveTrackingReference(inputRecordId);

        return integrationCalloutResponse;
    }
    
    
    // Call Mock Service API.
    private static HttpResponse makeCallout(industriesintegrationfwk.HttpBaseProvider httpProvider, String msgBody) {
        
        // Construct the request object
        String endPoint = MOCK_CALLOUT_NAMED_CREDENTIAL + '/delay/3';
        HttpRequest request = new HttpRequest();
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setHeader('Accept', 'application/json');
        request.setEndpoint(endPoint);
        request.setTimeout(TIMEOUT);
        request.setBody(msgBody);
        
        // Send request
        HttpResponse response = httpProvider.httpCallout(request);
                
        return response;
    } 
    
    // Process Response payLoad 
    private static Map<String, Object> getResponseGroupAfterCallout(HttpResponse response) {
        Map<String, Object> responseGroup = new Map<String, Object>();
        if (response.getStatusCode() == 200) {
            responseGroup.put('isSuccess', true);
        } else {
            responseGroup.put('isSuccess', false);
        }
        responseGroup.put('response', getResponseMap(response.getBody()));
        return responseGroup;
    }
    
    // Convert response string into Map 
    private static Map<String,Object> getResponseMap(String responseBody) {
        try {
            Map<String,Object> responseBodyMap = (Map<String,Object>) JSON.deserializeUntyped(responseBody);
            return responseBodyMap;
        } catch (Exception e) {
            Map<String, Object> responseMap = new Map<String,Object>();
            responseMap.put('response', responseBody);
            return responseMap;
        }
    }
    
    private static final industriesintegrationfwk.ApexProviderAttr NAMED_CRED_ATTR = new industriesintegrationfwk.ApexProviderAttr('Named Credential', 
    'Named_Credential', 'LogisticsSystemNC', true, 'String');
    private static final industriesintegrationfwk.ApexProviderAttr TIMEOUT_ATTR = new industriesintegrationfwk.ApexProviderAttr('Timeout (ms)', 
    'TimeoutMs', '10000', true, 'Integer');

   
    global static List<industriesintegrationfwk.ApexProviderAttr> getProviderAttributes() {
        List<industriesintegrationfwk.ApexProviderAttr> defaults = new List<industriesintegrationfwk.ApexProviderAttr>();
        defaults.add(NAMED_CRED_ATTR);
        defaults.add(TIMEOUT_ATTR);
        return defaults;
    }   
    
    public static void saveTrackingReference(String orderItemId){
    // save Tracking number on the Order Item
        OrderItem oi = [select id,  Description from OrderItem where id=:orderItemId];
        oi.Description = 'TrackingRef:TRK-HUBSWQT18-4238';
        update oi;
   
    }
}