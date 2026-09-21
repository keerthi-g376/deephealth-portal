public class UnlockRecordAction {
    @InvocableMethod(label='Unlock record' description='Unlocks a record' category='Record Automation')
    public static void unlock(List<Id> recordIds) {
        // Check if list is not empty
        if(!recordIds.isEmpty()) {
            // Unlock the records
            Approval.unlock(recordIds, false);
        }
    }
}