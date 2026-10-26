@IsTest
private class QuoteRestControllerTest {
    private static Contact customer() {
        Account a = new Account(Name = 'Acme');
        insert a;
        Contact c = new Contact(AccountId = a.Id, LastName = 'Doe', Email = 'doe@example.com');
        insert c;
        return c;
    }

    private static void callPost(Map<String, Object> body) {
        RestRequest rq = new RestRequest();
        rq.requestURI = '/services/apexrest/api/quotes/';
        rq.requestBody = Blob.valueOf(JSON.serialize(body));
        RestContext.request = rq;
        RestContext.response = new RestResponse();
        QuoteRestController.handlePost();
    }

    private static void callGet(String quoteId, String contactId) {
        RestRequest rq = new RestRequest();
        rq.requestURI = '/services/apexrest/api/quotes/' + (quoteId == null ? '' : quoteId);
        if (contactId != null) rq.addParameter('contactId', contactId);
        RestContext.request = rq;
        RestContext.response = new RestResponse();
        QuoteRestController.handleGet();
    }

    private static Quote newQuote(Contact c) {
        Id oppId = QuoteRestController.resolveOpportunityForContact(c.Id, null, null);
        Quote q = new Quote(Name = 'Q1', OpportunityId = oppId, ContactId = c.Id, Pricebook2Id = Test.getStandardPricebookId());
        insert q;
        return q;
    }

    @IsTest
    static void opportunityIsCreatedThenReusedForSameContact() {
        Contact c = customer();
        Id first = QuoteRestController.resolveOpportunityForContact(c.Id, null, null);
        Id second = QuoteRestController.resolveOpportunityForContact(c.Id, null, null);
        System.assertEquals(first, second, 'the open web opportunity is reused');
        System.assertEquals(1, [SELECT COUNT() FROM Opportunity WHERE AccountId = :c.AccountId]);
        System.assertEquals(1, [SELECT COUNT() FROM OpportunityContactRole WHERE OpportunityId = :first]);
    }

    @IsTest
    static void closedOpportunityIsNotReused() {
        Contact c = customer();
        Id first = QuoteRestController.resolveOpportunityForContact(c.Id, null, null);
        Opportunity o = [SELECT Id FROM Opportunity WHERE Id = :first];
        o.StageName = 'Closed Won';
        update o;
        Id second = QuoteRestController.resolveOpportunityForContact(c.Id, null, null);
        System.assertNotEquals(first, second);
    }

    @IsTest
    static void foreignOpportunityIsRejected() {
        Contact c = customer();
        Account other = new Account(Name = 'Other');
        insert other;
        Opportunity foreign = new Opportunity(Name = 'x', AccountId = other.Id, StageName = 'Prospecting', CloseDate = Date.today().addDays(5));
        insert foreign;
        try {
            QuoteRestController.resolveOpportunityForContact(c.Id, foreign.Id, null);
            System.assert(false, 'expected failure');
        } catch (QuoteRestController.QuoteApiException e) {
            System.assert(e.getMessage().contains('not found'));
        }
    }

    @IsTest
    static void listRequiresContactAndIsScoped() {
        callGet(null, null);
        System.assertEquals(400, RestContext.response.statusCode);

        Contact mine = customer();
        Contact other = new Contact(AccountId = mine.AccountId, LastName = 'Other', Email = 'other@example.com');
        insert other;
        newQuote(mine);

        callGet(null, mine.Id);
        System.assert(RestContext.response.responseBody.toString().contains('quoteNumber'));
        callGet(null, other.Id);
        System.assertEquals('[]', RestContext.response.responseBody.toString());
    }

    @IsTest
    static void detailOfAnotherCustomersQuoteLooksMissing() {
        Contact mine = customer();
        Contact other = new Contact(AccountId = mine.AccountId, LastName = 'Other', Email = 'other@example.com');
        insert other;
        Quote q = newQuote(mine);

        callGet(q.Id, mine.Id);
        System.assertNotEquals(400, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('quoteNumber'));
        callGet(q.Id, other.Id);
        System.assertEquals(400, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('not found'));
    }

    @IsTest
    static void failedCreateRollsBackAndSuccessfulCreateSetsContact() {
        Contact c = customer();
        callPost(new Map<String, Object>{
            'contactId' => c.Id,
            'lineItems' => new List<Object>{ new Map<String, Object>{ 'productId' => '', 'quantity' => 1 } }
        });
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Quote], 'failed create leaves no quote');
        System.assertEquals(0, [SELECT COUNT() FROM Opportunity], 'failed create leaves no opportunity');

        callPost(new Map<String, Object>{ 'contactId' => c.Id });
        System.assertEquals(201, RestContext.response.statusCode);
        System.assertEquals(c.Id, [SELECT ContactId FROM Quote LIMIT 1].ContactId);
    }

    private static void call(String verb, String quoteId, String contactId, Map<String, Object> body) {
        RestRequest rq = new RestRequest();
        rq.requestURI = '/services/apexrest/api/quotes/' + quoteId;
        if (contactId != null) rq.addParameter('contactId', contactId);
        if (body != null) rq.requestBody = Blob.valueOf(JSON.serialize(body));
        RestContext.request = rq;
        RestContext.response = new RestResponse();
        if (verb == 'PATCH') QuoteRestController.handlePatch();
        else QuoteRestController.handleDelete();
    }

    @IsTest
    static void customerEditsOnlyDraftAndOnlyOwnQuote() {
        Contact mine = customer();
        Contact other = new Contact(AccountId = mine.AccountId, LastName = 'Other', Email = 'other@example.com');
        insert other;
        Quote q = newQuote(mine);

        // another customer cannot change or delete it
        call('PATCH', q.Id, other.Id, new Map<String, Object>{ 'notes' => 'hijack' });
        System.assertEquals(400, RestContext.response.statusCode);
        call('DELETE', q.Id, other.Id, null);
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(1, [SELECT COUNT() FROM Quote WHERE Id = :q.Id]);

        // the owner can edit a Draft...
        call('PATCH', q.Id, mine.Id, new Map<String, Object>{ 'notes' => 'hello', 'lineItems' => new List<Object>() });
        System.assertNotEquals(400, RestContext.response.statusCode);
        System.assertEquals('hello', [SELECT Description FROM Quote WHERE Id = :q.Id].Description);

        // ...but not once it is no longer Draft (a revision is needed instead)
        q.Status = 'Pending';
        update q;
        call('PATCH', q.Id, mine.Id, new Map<String, Object>{ 'lineItems' => new List<Object>() });
        System.assertEquals(400, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('no longer be changed'));

        // the owner can delete it
        call('DELETE', q.Id, mine.Id, null);
        System.assertEquals(0, [SELECT COUNT() FROM Quote WHERE Id = :q.Id]);
    }

    @IsTest
    static void quoteWithLinesIsCreatedAndReplacedAtomically() {
        Contact c = customer();
        Product2 p = new Product2(Name = 'Scanner', IsActive = true);
        insert p;
        update new Pricebook2(Id = Test.getStandardPricebookId(), IsActive = true);
        insert new PricebookEntry(Pricebook2Id = Test.getStandardPricebookId(), Product2Id = p.Id, UnitPrice = 100, IsActive = true, CurrencyIsoCode = UserInfo.getDefaultCurrency());

        callPost(new Map<String, Object>{
            'contactId' => c.Id,
            'lineItems' => new List<Object>{ new Map<String, Object>{ 'productId' => p.Id, 'quantity' => 2, 'unitPrice' => 100 } }
        });
        System.assertEquals(201, RestContext.response.statusCode, RestContext.response.responseBody.toString());
        Quote q = [SELECT Id FROM Quote LIMIT 1];
        System.assertEquals(1, [SELECT COUNT() FROM QuoteLineItem WHERE QuoteId = :q.Id]);

        // a failing replace (unknown product) rolls back and keeps the existing line
        call('PATCH', q.Id, c.Id, new Map<String, Object>{
            'lineItems' => new List<Object>{ new Map<String, Object>{ 'productId' => '', 'quantity' => 1 } }
        });
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(1, [SELECT COUNT() FROM QuoteLineItem WHERE QuoteId = :q.Id]);
    }

    // ---------------------------------------------------------------- portal roles and quote actions

    private static Contact colleague(Contact boss, String email, String access) {
        Contact c = new Contact(AccountId = boss.AccountId, LastName = 'Mate', Email = email, Portal_Access__c = access);
        insert c;
        return c;
    }

    private static Contact adminOf(Contact c) {
        c.Portal_Account_Admin__c = true;
        update c;
        return c;
    }

    private static Quote quoteWithLine(Contact c) {
        Product2 p = new Product2(Name = 'Scanner ' + c.Email, IsActive = true);
        insert p;
        update new Pricebook2(Id = Test.getStandardPricebookId(), IsActive = true);
        insert new PricebookEntry(Pricebook2Id = Test.getStandardPricebookId(), Product2Id = p.Id, UnitPrice = 10, IsActive = true, CurrencyIsoCode = UserInfo.getDefaultCurrency());
        callPost(new Map<String, Object>{
            'contactId' => c.Id,
            'lineItems' => new List<Object>{ new Map<String, Object>{ 'productId' => p.Id, 'quantity' => 1, 'unitPrice' => 10 } }
        });
        System.assertEquals(201, RestContext.response.statusCode, RestContext.response.responseBody.toString());
        return [SELECT Id, Status, OpportunityId FROM Quote WHERE ContactId = :c.Id ORDER BY CreatedDate DESC LIMIT 1];
    }

    @IsTest
    static void pendingColleagueCannotListOrCreateQuotes() {
        Contact boss = customer();
        Contact pending = colleague(boss, 'pending@example.com', 'Pending');
        callGet(null, pending.Id);
        System.assertEquals(400, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('waiting for approval'));
        callPost(new Map<String, Object>{ 'contactId' => pending.Id });
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Quote]);
    }

    @IsTest
    static void accountAdminSeesAllAccountQuotesOthersOnlyTheirOwn() {
        Contact boss = adminOf(customer());
        Contact mate = colleague(boss, 'mate@example.com', 'Active');
        Quote bossQuote = newQuote(boss);
        Quote mateQuote = newQuote(mate);

        RestRequest rq = new RestRequest();
        rq.requestURI = '/services/apexrest/api/quotes/';
        rq.addParameter('contactId', boss.Id);
        rq.addParameter('scope', 'account');
        RestContext.request = rq;
        RestContext.response = new RestResponse();
        QuoteRestController.handleGet();
        List<Object> all = (List<Object>) JSON.deserializeUntyped(RestContext.response.responseBody.toString());
        System.assertEquals(2, all.size());

        callGet(null, mate.Id); // the colleague, without scope, sees only their own
        System.assertEquals(1, ((List<Object>) JSON.deserializeUntyped(RestContext.response.responseBody.toString())).size());

        callGet(mateQuote.Id, boss.Id); // admin may open a colleague's quote
        System.assertNotEquals(400, RestContext.response.statusCode);
        callGet(bossQuote.Id, mate.Id); // a colleague may not open the admin's
        System.assertEquals(400, RestContext.response.statusCode);
        call('PATCH', mateQuote.Id, boss.Id, new Map<String, Object>{ 'notes' => 'x' }); // admin cannot silently edit it
        System.assertEquals(400, RestContext.response.statusCode);
    }

    @IsTest
    static void customerSubmitsAcceptsOrDeclinesAndOpportunityFollows() {
        Contact c = customer();
        Quote q = quoteWithLine(c);
        System.assertEquals('Draft', q.Status);

        call('PATCH', q.Id, c.Id, new Map<String, Object>{ 'status' => 'Accepted' });
        System.assertEquals(400, RestContext.response.statusCode, 'a Draft cannot be accepted');

        call('PATCH', q.Id, c.Id, new Map<String, Object>{ 'status' => 'Needs Review' });
        System.assertNotEquals(400, RestContext.response.statusCode, RestContext.response.responseBody.toString());
        System.assertEquals('Needs Review', [SELECT Status FROM Quote WHERE Id = :q.Id].Status);

        call('PATCH', q.Id, c.Id, new Map<String, Object>{ 'lineItems' => new List<Object>() });
        System.assertEquals(400, RestContext.response.statusCode, 'locked once submitted');

        update new Quote(Id = q.Id, Status = 'Approved'); // the Salesforce team approves
        Test.startTest();
        call('PATCH', q.Id, c.Id, new Map<String, Object>{ 'status' => 'Accepted' });
        Test.stopTest();
        System.assertEquals('Accepted', [SELECT Status FROM Quote WHERE Id = :q.Id].Status);
        System.assertEquals('Closed Won', [SELECT StageName FROM Opportunity WHERE Id = :q.OpportunityId].StageName);
    }

    @IsTest
    static void customerCanDeclineAndOpportunityClosesLost() {
        Contact c = customer();
        Quote q = quoteWithLine(c);
        Test.startTest();
        call('PATCH', q.Id, c.Id, new Map<String, Object>{ 'status' => 'Denied', 'notes' => 'Not interested: price' });
        Test.stopTest();
        System.assertEquals('Denied', [SELECT Status FROM Quote WHERE Id = :q.Id].Status);
        System.assertEquals('Closed Lost', [SELECT StageName FROM Opportunity WHERE Id = :q.OpportunityId].StageName);
    }

    @IsTest
    static void submittingAnEmptyQuoteIsRefused() {
        Contact c = customer();
        Quote q = newQuote(c);
        call('PATCH', q.Id, c.Id, new Map<String, Object>{ 'status' => 'Needs Review' });
        System.assertEquals(400, RestContext.response.statusCode);
    }

    @IsTest
    static void revisionSupersedesTheOldQuoteAndAddressesAreCopied() {
        Contact c = customer();
        update new Account(Id = c.AccountId, BillingCity = 'Leeds', BillingCountry = 'United Kingdom', ShippingCity = 'York', ShippingCountry = 'United Kingdom');
        Quote first = quoteWithLine(c);
        Quote created = [SELECT BillingCity, ShippingCity, BillingName FROM Quote WHERE Id = :first.Id];
        System.assertEquals('Leeds', created.BillingCity);
        System.assertEquals('York', created.ShippingCity);
        System.assertEquals('Acme', created.BillingName);

        update new Quote(Id = first.Id, Status = 'Approved');
        callPost(new Map<String, Object>{ 'contactId' => c.Id, 'opportunityId' => first.OpportunityId, 'supersedes' => first.Id });
        System.assertEquals(201, RestContext.response.statusCode, RestContext.response.responseBody.toString());
        System.assertEquals('Superseded', [SELECT Status FROM Quote WHERE Id = :first.Id].Status);
        System.assertEquals(2, [SELECT COUNT() FROM Quote WHERE OpportunityId = :first.OpportunityId], 'the revision is on the same opportunity');
    }
}
