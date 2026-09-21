public class UpdateContractController {
@AuraEnabled
    public static List<String> getUpdatedRecord(String sourceRecordId, Boolean autoDocgen) {
        ConnectApi.ContractInputRepresentation objInput = new ConnectApi.ContractInputRepresentation();
        objInput.sourceObjectId = sourceRecordId;
        objInput.isAutoDocgenRequired = autoDocgen;
        ConnectApi.ContractOutputRepresentation objOutput = ConnectApi.Clm.updateContract(objInput);
         List<String> contractData = new List<String>();
        contractData.add(objOutput.data[0]);
        return contractData;
        
    }
}