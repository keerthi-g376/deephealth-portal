public class CreateContractController {
@AuraEnabled
    public static List<String> getCreatedRecord(String sourceRecordId, Boolean autoDocgen) {
        ConnectApi.ContractInputRepresentation objInput = new ConnectApi.ContractInputRepresentation();
        objInput.sourceObjectId = sourceRecordId;
        objInput.isAutoDocgenRequired = autoDocgen;
        ConnectApi.ContractOutputRepresentation objOutput = ConnectApi.Clm.createContract(objInput);
         List<String> contractData = new List<String>();
        contractData.add(objOutput.data[0]);
         List<Contract> contractName = [SELECT Name FROM Contract WHERE Id =:objOutput.data[0]];
        contractData.add(contractName[0].Name);
        return contractData;
        
    }
}