public class ContractArchivalUtility { 

    /**
     * Moves ONLY 'Activated' Contracts from Source to Archive Account.
     * Strategy: Unlock (Draft) -> Move -> Relock (Activated).
     */
    public static void archiveActiveContracts(Id sourceAccountId, Id archiveAccountId) { 
        
        // 1. Validation
        if (sourceAccountId == null || archiveAccountId == null) { 
            System.debug('ERROR: Both Source and Archive Account IDs are required.'); 
            return; 
        } 
     
        // 2. Query ONLY Active Contracts (and their Active Orders)
        // We need inner query for Orders because Active Orders prevent Contract unlocking.
        List<Contract> contractsToMove = [ 
            SELECT Id, AccountId, Status,
                   (SELECT Id, Status FROM Orders WHERE Status = 'Activated') 
            FROM Contract  
            WHERE AccountId = :sourceAccountId  
            AND Status = 'Activated' 
            LIMIT 10000 
        ]; 
     
        if (contractsToMove.isEmpty()) { 
            System.debug('No Active contracts found on Source Account.'); 
            return; 
        } 
     
        // Lists to manage updates
        List<Contract> contractsToUpdate = new List<Contract>();
        List<Order> ordersToUpdate = new List<Order>();

        // 3. Processing Loop
        for (Contract c : contractsToMove) { 
            
            // A. Handle Orders: If Orders are Active, we must set them to Draft temporarily
            if(c.Orders != null && !c.Orders.isEmpty()) {
                for(Order o : c.Orders) {
                    o.Status = 'Draft'; 
                    ordersToUpdate.add(o);
                }
            }

            // B. Unlock Contract: Must be 'Draft' to change the AccountId
            c.Status = 'Draft';       
            c.AccountId = archiveAccountId; // Set new Account
            
            contractsToUpdate.add(c); 
        } 
     
        // 4. Execution with Safety Rollback
        Savepoint sp = Database.setSavepoint(); 

        try { 
            System.debug('--- STARTING MOVE ---');

            // PHASE 1: UNLOCK
            // Set Orders to Draft (if any) so we can touch the Contract
            if(!ordersToUpdate.isEmpty()) {
                update ordersToUpdate;
            }

            // PHASE 2: MOVE
            // Save Contracts as Draft on the new Account
            if(!contractsToUpdate.isEmpty()) {
                update contractsToUpdate;
                System.debug('Moved ' + contractsToUpdate.size() + ' contracts (Status: Temporarily Draft).');
            }

            // PHASE 3: RELOCK (The Requirement)
            // Now that they are on the new Account, force them back to ACTIVATED immediately.
            for(Contract c : contractsToUpdate) {
                c.Status = 'Activated';
            }
            update contractsToUpdate;
            System.debug('Restored Contracts to Activated status.');

            // PHASE 4: RESTORE ORDERS
            // Put Orders back to Activated
            if(!ordersToUpdate.isEmpty()) {
                for(Order o : ordersToUpdate) {
                    o.Status = 'Activated';
                }
                update ordersToUpdate;
            }
            
            System.debug('SUCCESS: All Contracts moved and remain Activated.');

        } catch (Exception e) { 
            Database.rollback(sp); // If anything fails, undo all changes
            System.debug('CRITICAL ERROR: Transaction rolled back.'); 
            System.debug('Message: ' + e.getMessage()); 
        } 
    } 
}