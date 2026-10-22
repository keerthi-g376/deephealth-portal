/**
 * PortalLeadService
 * POST /services/apexrest/portal/leads  - creates a Lead from the web portal "I'm interested" form.
 * One Lead per email: an open Lead with the same email is updated (interest appended) instead of duplicated.
 * Runs with sharing; the integration user needs Create/Read/Edit on Lead and access to this class.
 */
@RestResource(urlMapping='/portal/leads')
global with sharing class PortalLeadService {
    global class LeadRequest {
        public String firstName;
        public String lastName;
        public String email;
        public String company;
        public String phone;
        public String country;
        public String currencyCode;
        public List<String> productIds;
        public String message;
    }

    @HttpPost
    global static void createLead() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        try {
            LeadRequest req = (LeadRequest) JSON.deserialize(RestContext.request.requestBody.toString(), LeadRequest.class);
            validate(req);
            Id leadId = upsertLead(req);
            res.statusCode = 201;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{ 'id' => leadId }));
        } catch (Exception ex) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{ 'error' => ex.getMessage() }));
        }
    }

    @TestVisible
    private static void validate(LeadRequest r) {
        if (r == null || String.isBlank(r.lastName) || String.isBlank(r.email) || String.isBlank(r.company)) {
            throw new IllegalArgumentException('Name, email and company are required');
        }
    }

    @TestVisible
    private static Id upsertLead(LeadRequest r) {
        String interest = buildInterest(r);
        List<Lead> existing = [
            SELECT Id, Description
            FROM Lead
            WHERE Email = :r.email AND IsConverted = false
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (!existing.isEmpty()) {
            Lead l = existing[0];
            String note = String.isBlank(l.Description) ? interest : l.Description + '\n---\n' + interest;
            l.Description = note.left(32000);
            update as user l;
            return l.Id;
        }
        Lead l = new Lead(
            FirstName = r.firstName,
            LastName = r.lastName,
            Email = r.email,
            Company = r.company,
            Phone = r.phone,
            Country = r.country,
            LeadSource = 'Web',
            Description = interest.left(32000)
        );
        Database.insert(l, allowDuplicates(), AccessLevel.USER_MODE);
        return l.Id;
    }

    // An existing Contact or Lead with the same email must not stop the enquiry being recorded.
    private static Database.DMLOptions allowDuplicates() {
        Database.DMLOptions opts = new Database.DMLOptions();
        opts.duplicateRuleHeader.allowSave = true;
        return opts;
    }

    private static String buildInterest(LeadRequest r) {
        List<String> names = new List<String>();
        if (r.productIds != null && !r.productIds.isEmpty()) {
            for (Product2 p : [SELECT Name FROM Product2 WHERE Id IN :r.productIds WITH USER_MODE LIMIT 50]) {
                names.add(p.Name);
            }
        }
        String text = 'Web enquiry (' + String.valueOf(r.currencyCode) + ')';
        if (!names.isEmpty()) text += '\nProducts: ' + String.join(names, ', ');
        if (String.isNotBlank(r.message)) text += '\n' + r.message;
        return text;
    }
}
