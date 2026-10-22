@IsTest
private class PortalCustomerServiceTest {
    private static PortalCustomerService.CustomerRequest req(String email) {
        PortalCustomerService.CustomerRequest r = new PortalCustomerService.CustomerRequest();
        r.email = email;
        return r;
    }

    @IsTest
    static void existingContactIsReturned() {
        Account a = new Account(Name = 'Acme');
        insert a;
        Contact c = new Contact(AccountId = a.Id, LastName = 'Doe', Email = 'doe@example.com');
        insert c;
        Map<String, Object> out = PortalCustomerService.resolve(req('doe@example.com'));
        System.assertEquals(c.Id, (Id) out.get('contactId'));
        System.assertEquals(a.Id, (Id) out.get('accountId'));
    }

    @IsTest
    static void openLeadIsConvertedWithoutOpportunity() {
        insert new Lead(LastName = 'Lead', Company = 'LeadCo', Email = 'lead@example.com');
        Map<String, Object> out = PortalCustomerService.resolve(req('lead@example.com'));
        System.assertNotEquals(null, out.get('contactId'));
        System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE Email = 'lead@example.com' AND IsConverted = true]);
        System.assertEquals(0, [SELECT COUNT() FROM Opportunity]);
    }

    @IsTest
    static void leadIsConvertedIntoExistingContact() {
        Account a = new Account(Name = 'Acme');
        insert a;
        Contact c = new Contact(AccountId = a.Id, LastName = 'Doe', Email = 'both@example.com');
        insert c;
        Database.DMLOptions opts = new Database.DMLOptions();
        opts.duplicateRuleHeader.allowSave = true;
        Database.insert(new Lead(LastName = 'Doe', Company = 'Acme', Email = 'both@example.com'), opts);
        Map<String, Object> out = PortalCustomerService.resolve(req('both@example.com'));
        System.assertEquals(c.Id, (Id) out.get('contactId'));
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE Email = 'both@example.com']);
    }

    @IsTest
    static void unknownEmailNeedsProfileThenCreates() {
        System.assertEquals(true, PortalCustomerService.resolve(req('new@example.com')).get('needsProfile'));
        PortalCustomerService.CustomerRequest r = req('new@example.com');
        r.lastName = 'New';
        r.company = 'NewCo';
        Map<String, Object> out = PortalCustomerService.resolve(r);
        System.assertNotEquals(null, out.get('contactId'));
        System.assertEquals(1, [SELECT COUNT() FROM Account WHERE Name = 'NewCo']);
    }

    @IsTest
    static void sendCodeValidatesFormat() {
        PortalCustomerService.CustomerRequest r = req('x@example.com');
        r.code = 'abc';
        try {
            PortalCustomerService.sendCode(r);
            System.assert(false, 'expected failure');
        } catch (IllegalArgumentException e) {
            System.assertEquals('Invalid code', e.getMessage());
        }
        r.code = '123456';
        System.assertEquals(true, PortalCustomerService.sendCode(r).get('sent'));
    }

    private static void post(String action, Map<String, Object> body) {
        RestRequest rq = new RestRequest();
        rq.requestURI = '/services/apexrest/portal/customer/' + action;
        rq.requestBody = Blob.valueOf(JSON.serialize(body));
        RestContext.request = rq;
        RestContext.response = new RestResponse();
        PortalCustomerService.handle();
    }

    @IsTest
    static void restEntryPointRoutesAndRejects() {
        post('resolve', new Map<String, Object>{ 'email' => 'nobody@example.com' });
        System.assertEquals(200, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('needsProfile'));
        post('mail', new Map<String, Object>{ 'email' => 'nobody@example.com', 'code' => '123456' });
        System.assertEquals(200, RestContext.response.statusCode);
        post('bogus', new Map<String, Object>{ 'email' => 'nobody@example.com' });
        System.assertEquals(400, RestContext.response.statusCode);
        post('resolve', new Map<String, Object>{ 'email' => '' });
        System.assertEquals(400, RestContext.response.statusCode);
    }
}
