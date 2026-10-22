@IsTest
private class PortalLeadServiceTest {
    private static PortalLeadService.LeadRequest request(String email) {
        PortalLeadService.LeadRequest r = new PortalLeadService.LeadRequest();
        r.lastName = 'Tester';
        r.email = email;
        r.company = 'Acme Health';
        r.country = 'Germany';
        r.currencyCode = 'EUR';
        r.message = 'Interested';
        return r;
    }

    private static void post(PortalLeadService.LeadRequest r) {
        RestRequest rq = new RestRequest();
        rq.requestBody = Blob.valueOf(JSON.serialize(r));
        RestContext.request = rq;
        RestContext.response = new RestResponse();
        PortalLeadService.createLead();
    }

    @IsTest
    static void createsLeadFromWeb() {
        post(request('new@example.com'));
        System.assertEquals(201, RestContext.response.statusCode);
        Lead l = [SELECT LeadSource, Country, Company FROM Lead WHERE Email = 'new@example.com'];
        System.assertEquals('Web', l.LeadSource);
        System.assertEquals('Germany', l.Country);
    }

    @IsTest
    static void sameEmailUpdatesInsteadOfDuplicating() {
        post(request('dup@example.com'));
        post(request('dup@example.com'));
        System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE Email = 'dup@example.com']);
    }

    @IsTest
    static void rejectsMissingFields() {
        PortalLeadService.LeadRequest r = request('x@example.com');
        r.company = null;
        post(r);
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
    }
}
