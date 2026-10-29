@IsTest
private class PortalCustomerServiceTest {
    private static PortalCustomerService.CustomerRequest req(String email) {
        PortalCustomerService.CustomerRequest r = new PortalCustomerService.CustomerRequest();
        r.email = email;
        return r;
    }

    private static PortalCustomerService.Address address() {
        PortalCustomerService.Address a = new PortalCustomerService.Address();
        a.street = '1 Main St';
        a.city = 'Leeds';
        a.postalCode = 'LS1';
        a.country = 'United Kingdom';
        return a;
    }

    private static PortalCustomerService.CustomerRequest fullProfile(String email, String company) {
        PortalCustomerService.CustomerRequest r = req(email);
        r.firstName = 'Ann';
        r.lastName = 'New';
        r.company = company;
        r.billing = address();
        return r;
    }

    private static Contact existingCustomer() {
        Account a = new Account(Name = 'Acme');
        insert a;
        Contact c = new Contact(AccountId = a.Id, FirstName = 'Dee', LastName = 'Doe', Email = 'doe@acme.com');
        insert c;
        return c;
    }

    @IsTest
    static void existingContactSignsInAsActive() {
        Contact c = existingCustomer();
        Map<String, Object> out = PortalCustomerService.resolve(req('DOE@acme.com '.trim().toLowerCase()));
        System.assertEquals(c.Id, (Id) out.get('contactId'));
        System.assertEquals(c.AccountId, (Id) out.get('accountId'));
        System.assertEquals('Active', out.get('access'));
        System.assertEquals(false, out.get('isAdmin'));
    }

    @IsTest
    static void newCompanyNeedsProfileThenBecomesAdmin() {
        System.assertEquals(true, PortalCustomerService.resolve(req('ann@newco.com')).get('needsProfile'));
        System.assertEquals(false, PortalCustomerService.resolve(req('ann@newco.com')).get('domainMatch'));

        Map<String, Object> out = PortalCustomerService.resolve(fullProfile('ann@newco.com', 'NewCo'));
        System.assertEquals('Active', out.get('access'));
        System.assertEquals(true, out.get('isAdmin'));
        Account acc = [SELECT Name, BillingCity, ShippingCity FROM Account WHERE Id = :(Id) out.get('accountId')];
        System.assertEquals('NewCo', acc.Name);
        System.assertEquals('Leeds', acc.BillingCity);
        System.assertEquals('Leeds', acc.ShippingCity, 'shipping defaults to billing');
    }

    @IsTest
    static void registrationNeedsNoAddress() {
        PortalCustomerService.CustomerRequest r = req('simple@simpleco.com');
        r.firstName = 'Sam';
        r.lastName = 'Simple';
        r.company = 'SimpleCo';
        Map<String, Object> out = PortalCustomerService.resolve(r);
        System.assertEquals(true, out.get('isAdmin'));
        Account acc = [SELECT Name, BillingCity FROM Account WHERE Id = :(Id) out.get('accountId')];
        System.assertEquals('SimpleCo', acc.Name);
        System.assertEquals(null, acc.BillingCity);
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE Email = 'simple@simpleco.com']);
    }

    @IsTest
    static void individualGetsPlaceholderAccount() {
        PortalCustomerService.CustomerRequest r = fullProfile('solo@gmail.com', null);
        r.individual = true;
        Map<String, Object> out = PortalCustomerService.resolve(r);
        System.assertEquals('Individual - Ann New', [SELECT Name FROM Account WHERE Id = :(Id) out.get('accountId')].Name);
    }

    @IsTest
    static void leadWaitsForProfileThenConvertsWithoutOpportunity() {
        insert new Lead(LastName = 'Lead', Company = 'LeadCo', Email = 'lead@leadco.com');
        System.assertEquals(true, PortalCustomerService.resolve(req('lead@leadco.com')).get('needsProfile'));
        System.assertEquals(0, [SELECT COUNT() FROM Lead WHERE IsConverted = true]);

        Map<String, Object> out = PortalCustomerService.resolve(fullProfile('lead@leadco.com', 'LeadCo Ltd'));
        System.assertEquals(true, out.get('isAdmin'));
        System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE IsConverted = true]);
        System.assertEquals(0, [SELECT COUNT() FROM Opportunity]);
        System.assertEquals('LeadCo Ltd', [SELECT Name FROM Account WHERE Id = :(Id) out.get('accountId')].Name);
    }

    @IsTest
    static void leadIsConvertedIntoExistingContact() {
        Contact c = existingCustomer();
        Database.DMLOptions opts = new Database.DMLOptions();
        opts.duplicateRuleHeader.allowSave = true;
        Database.insert(new Lead(LastName = 'Doe', Company = 'Acme', Email = 'doe@acme.com'), opts);
        Map<String, Object> out = PortalCustomerService.resolve(req('doe@acme.com'));
        System.assertEquals(c.Id, (Id) out.get('contactId'));
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE Email = 'doe@acme.com']);
        System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE IsConverted = true]);
    }

    @IsTest
    static void colleagueOnSameDomainWaitsForApproval() {
        Contact c = existingCustomer();
        System.assertEquals(true, PortalCustomerService.resolve(req('new@acme.com')).get('domainMatch'));

        PortalCustomerService.CustomerRequest r = req('new@acme.com');
        r.firstName = 'Nina';
        r.lastName = 'Newcomer';
        Map<String, Object> out = PortalCustomerService.resolve(r);
        System.assertEquals(c.AccountId, (Id) out.get('accountId'), 'attached to the existing account');
        System.assertEquals('Pending', out.get('access'));
        System.assertEquals(false, out.get('isAdmin'));
        System.assertEquals(1, [SELECT COUNT() FROM Task WHERE WhatId = :c.AccountId], 'account owner is asked to approve');
        System.assertEquals(1, [SELECT COUNT() FROM Account WHERE Name = 'Acme']);
    }

    @IsTest
    static void companyNameMatchAlsoWaitsForApproval() {
        Contact c = existingCustomer();
        PortalCustomerService.CustomerRequest r = fullProfile('person@gmail.com', 'Acme');
        Map<String, Object> ask = PortalCustomerService.resolve(r);
        System.assertEquals(true, ask.get('needsProfile'), 'the person is first told the company already exists');
        System.assertEquals(true, ask.get('byName'));
        System.assertEquals('Acme', ask.get('accountName'));
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE AccountId = :c.AccountId], 'nothing created yet');
        r.joinExisting = true;
        Map<String, Object> out = PortalCustomerService.resolve(r);
        System.assertEquals(c.AccountId, (Id) out.get('accountId'));
        System.assertEquals('Pending', out.get('access'));
    }

    @IsTest
    static void emptyExistingAccountMakesTheFirstPersonItsAdmin() {
        Account a = new Account(Name = 'Ghost Clinic');
        insert a;
        PortalCustomerService.CustomerRequest r = fullProfile('first@gmail.com', 'Ghost Clinic');
        System.assertEquals(true, PortalCustomerService.resolve(r).get('byName'), 'told the company already exists first');
        r.joinExisting = true;
        Map<String, Object> out = PortalCustomerService.resolve(r);
        System.assertEquals(a.Id, (Id) out.get('accountId'), 'attached to the existing empty account');
        System.assertEquals('Active', out.get('access'));
        System.assertEquals(true, out.get('isAdmin'));
        System.assertEquals(1, [SELECT COUNT() FROM Account WHERE Name = 'Ghost Clinic']);
    }

    @IsTest
    static void freeMailDomainNeverMatchesAnAccount() {
        Account a = new Account(Name = 'Gmail Fan');
        insert a;
        insert new Contact(AccountId = a.Id, LastName = 'Fan', Email = 'fan@gmail.com');
        Map<String, Object> out = PortalCustomerService.resolve(req('stranger@gmail.com'));
        System.assertEquals(false, out.get('domainMatch'));
        System.assertEquals(true, out.get('needsProfile'));
    }

    @IsTest
    static void profileIsEditableAndAccountAddressOnlyByAdmin() {
        Map<String, Object> adminOut = PortalCustomerService.resolve(fullProfile('boss@bossco.com', 'BossCo'));
        Id adminId = (Id) adminOut.get('contactId');

        PortalCustomerService.CustomerRequest save = new PortalCustomerService.CustomerRequest();
        save.contactId = adminId;
        save.firstName = 'Bo';
        save.lastName = 'Boss';
        save.phone = '123';
        save.billing = address();
        save.billing.city = 'York';
        PortalCustomerService.saveProfile(save);
        System.assertEquals('York', [SELECT BillingCity FROM Account WHERE Name = 'BossCo'].BillingCity);
        System.assertEquals('123', [SELECT Phone FROM Contact WHERE Id = :adminId].Phone);

        PortalCustomerService.CustomerRequest mate = req('mate@bossco.com');
        mate.firstName = 'Mate';
        mate.lastName = 'Mate';
        Id mateId = (Id) PortalCustomerService.resolve(mate).get('contactId');
        PortalCustomerService.CustomerRequest edit = new PortalCustomerService.CustomerRequest();
        edit.contactId = mateId;
        edit.lastName = 'Mate2';
        edit.billing = address();
        edit.billing.city = 'Hacked';
        PortalCustomerService.saveProfile(edit);
        System.assertEquals('York', [SELECT BillingCity FROM Account WHERE Name = 'BossCo'].BillingCity, 'a colleague cannot change the account address');
        System.assertEquals('Mate2', [SELECT LastName FROM Contact WHERE Id = :mateId].LastName);
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
        Contact c = existingCustomer();
        post('resolve', new Map<String, Object>{ 'email' => 'nobody@nowhere.org' });
        System.assertEquals(200, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('needsProfile'));
        post('mail', new Map<String, Object>{ 'email' => 'nobody@nowhere.org', 'code' => '123456' });
        System.assertEquals(200, RestContext.response.statusCode);
        post('status', new Map<String, Object>{ 'contactId' => c.Id });
        System.assert(RestContext.response.responseBody.toString().contains('Active'));
        post('profile', new Map<String, Object>{ 'contactId' => c.Id });
        System.assertEquals(200, RestContext.response.statusCode);
        post('bogus', new Map<String, Object>{ 'email' => 'nobody@nowhere.org' });
        System.assertEquals(400, RestContext.response.statusCode);
        post('resolve', new Map<String, Object>{ 'email' => '' });
        System.assertEquals(400, RestContext.response.statusCode);
    }
}
