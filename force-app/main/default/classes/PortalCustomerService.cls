/**
 * PortalCustomerService
 *   POST /services/apexrest/portal/customer/mail     { email, code }  -> emails the sign-in code
 *   POST /services/apexrest/portal/customer/resolve  { email, firstName, lastName, company, country }
 *        -> returns the verified customer's Contact/Account. Called only after the portal has verified the email.
 *
 * Resolve order (no duplicates are created):
 *   1. an existing Contact with that email is used (an open Lead with the same email is converted INTO it);
 *   2. else an open Lead with that email is converted (Account + Contact, no Opportunity: quotes create/reuse it);
 *   3. else, when name and company were supplied, an Account + Contact are created;
 *   4. else { needsProfile: true } is returned so the portal can ask for name and company.
 * Runs with sharing; the integration user needs Create/Read/Edit on Lead, Contact, Account and Convert Leads.
 */
@RestResource(urlMapping='/portal/customer/*')
global with sharing class PortalCustomerService {
    global class CustomerRequest {
        public String email;
        public String code;
        public String firstName;
        public String lastName;
        public String company;
        public String country;
    }

    @HttpPost
    global static void handle() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        try {
            CustomerRequest req = (CustomerRequest) JSON.deserialize(RestContext.request.requestBody.toString(), CustomerRequest.class);
            if (req == null || String.isBlank(req.email)) throw new IllegalArgumentException('Email is required');
            String action = RestContext.request.requestURI.substringAfterLast('/');
            Object result;
            if (action == 'mail') {
                result = sendCode(req);
            } else if (action == 'resolve') {
                result = resolve(req);
            } else {
                throw new IllegalArgumentException('Unknown action');
            }
            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(result));
        } catch (Exception ex) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{ 'error' => ex.getMessage() }));
        }
    }

    @TestVisible
    private static Map<String, Object> sendCode(CustomerRequest req) {
        if (String.isBlank(req.code) || !Pattern.matches('[0-9]{6}', req.code)) {
            throw new IllegalArgumentException('Invalid code');
        }
        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setToAddresses(new List<String>{ req.email });
        mail.setSubject('Your CareSphere Health sign-in code');
        mail.setPlainTextBody('Your sign-in code is ' + req.code + '. It expires in 10 minutes. If you did not request it, ignore this email.');
        mail.setSaveAsActivity(false);
        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });
        return new Map<String, Object>{ 'sent' => true };
    }

    private static Database.DMLOptions allowDuplicates() {
        Database.DMLOptions opts = new Database.DMLOptions();
        opts.duplicateRuleHeader.allowSave = true;
        return opts;
    }

    @TestVisible
    private static Map<String, Object> resolve(CustomerRequest req) {
        List<Contact> contacts = [
            SELECT Id, AccountId
            FROM Contact
            WHERE Email = :req.email AND AccountId != null
            ORDER BY LastModifiedDate DESC
            LIMIT 1
        ];
        List<Lead> leads = [
            SELECT Id
            FROM Lead
            WHERE Email = :req.email AND IsConverted = false
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];

        Id contactId;
        if (!leads.isEmpty()) {
            Database.LeadConvert lc = new Database.LeadConvert();
            lc.setLeadId(leads[0].Id);
            lc.setConvertedStatus([SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1].MasterLabel);
            lc.setDoNotCreateOpportunity(true); // the quote flow creates or reuses the Opportunity
            if (!contacts.isEmpty()) {
                lc.setAccountId(contacts[0].AccountId);
                lc.setContactId(contacts[0].Id);
            }
            Database.LeadConvertResult r = Database.convertLead(lc);
            if (!r.isSuccess()) {
                throw new IllegalArgumentException('Could not convert the lead: ' + r.getErrors()[0].getMessage());
            }
            contactId = r.getContactId();
        } else if (!contacts.isEmpty()) {
            contactId = contacts[0].Id;
        } else if (String.isNotBlank(req.lastName) && String.isNotBlank(req.company)) {
            Account a = new Account(Name = req.company, BillingCountry = req.country);
            Database.insert(a, allowDuplicates(), AccessLevel.USER_MODE);
            Contact created = new Contact(AccountId = a.Id, FirstName = req.firstName, LastName = req.lastName, Email = req.email, LeadSource = 'Web');
            Database.insert(created, allowDuplicates(), AccessLevel.USER_MODE);
            contactId = created.Id;
        } else {
            return new Map<String, Object>{ 'needsProfile' => true };
        }

        Contact c = [SELECT Id, FirstName, LastName, Email, AccountId FROM Contact WHERE Id = :contactId LIMIT 1];
        return new Map<String, Object>{
            'contactId' => c.Id,
            'accountId' => c.AccountId,
            'name' => String.join(new List<String>{ c.FirstName, c.LastName }, ' ').trim(),
            'email' => c.Email
        };
    }
}
