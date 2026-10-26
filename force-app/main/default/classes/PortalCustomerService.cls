/**
 * PortalCustomerService
 *   POST /services/apexrest/portal/customer/{action}
 *     mail        { email, code }                         -> emails the sign-in code
 *     resolve     { email, names, company, addresses }    -> signs in / registers a verified email
 *     status      { contactId }                           -> current access state and role
 *     profile     { contactId }                           -> contact + account details for My Profile
 *     saveProfile { contactId, ... }                      -> updates them
 *
 * Resolve order (no duplicates are created):
 *   1. A Contact with that email is the customer (an open Lead with the same email is converted INTO it).
 *   2. Else, if the email domain (free-mail domains excluded) or the typed company name matches an existing Account,
 *      a NEW Contact is created under it with Portal Access = Pending and the Account Owner is notified.
 *   3. Else a new Account and Contact are created; the first Contact becomes the Portal Account Admin.
 *   4. When more details are needed, { needsProfile: true, domainMatch } is returned.
 * Runs with sharing; the integration user needs Create/Read/Edit on Lead, Contact, Account, Task and Convert Leads.
 */
@RestResource(urlMapping='/portal/customer/*')
global with sharing class PortalCustomerService {
    global class Address {
        public String street;
        public String city;
        public String state;
        public String postalCode;
        public String country;
    }

    global class CustomerRequest {
        public String email;
        public String code;
        public String contactId;
        public String firstName;
        public String lastName;
        public String phone;
        public String company;
        public String country;
        public Boolean individual;
        public Address billing;
        public Address shipping;
    }

    private static final Set<String> FREE_DOMAINS = new Set<String>{
        'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
        'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
        'yandex.com', 'rediffmail.com'
    };

    @HttpPost
    global static void handle() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        try {
            CustomerRequest req = (CustomerRequest) JSON.deserialize(RestContext.request.requestBody.toString(), CustomerRequest.class);
            String action = RestContext.request.requestURI.substringAfterLast('/');
            Object result;
            if (action == 'mail') {
                result = sendCode(requireEmail(req));
            } else if (action == 'resolve') {
                result = resolve(requireEmail(req));
            } else if (action == 'status') {
                result = payload(requireContact(req));
            } else if (action == 'profile') {
                result = profile(requireContact(req));
            } else if (action == 'saveProfile') {
                result = saveProfile(req);
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

    private static CustomerRequest requireEmail(CustomerRequest req) {
        if (req == null || String.isBlank(req.email)) throw new IllegalArgumentException('Email is required');
        req.email = req.email.trim().toLowerCase();
        return req;
    }

    private static Id requireContact(CustomerRequest req) {
        if (req == null || String.isBlank(req.contactId)) throw new IllegalArgumentException('Customer is required');
        return (Id) req.contactId;
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

    // ---------------------------------------------------------------- matching

    // The Account a new person most likely belongs to: the Account with the most Contacts on the same company email
    // domain, else an Account whose name equals the typed company. Free-mail domains never match.
    @TestVisible
    private static Account findAccount(String email, String company) {
        String domain = email.substringAfter('@');
        if (!FREE_DOMAINS.contains(domain) && !domain.contains('%') && !domain.contains('_')) {
            String pattern = '%@' + domain;
            List<AggregateResult> hits = [
                SELECT AccountId a, COUNT(Id) n
                FROM Contact
                WHERE Email LIKE :pattern AND AccountId != null
                GROUP BY AccountId
                ORDER BY COUNT(Id) DESC
                LIMIT 1
            ];
            if (!hits.isEmpty()) {
                Id accId = (Id) hits[0].get('a');
                return [SELECT Id, Name, OwnerId FROM Account WHERE Id = :accId LIMIT 1];
            }
        }
        if (String.isNotBlank(company)) {
            List<Account> byName = [SELECT Id, Name, OwnerId FROM Account WHERE Name = :company.trim() ORDER BY CreatedDate LIMIT 1];
            if (!byName.isEmpty()) return byName[0];
        }
        return null;
    }

    private static Database.DMLOptions allowDuplicates() {
        Database.DMLOptions opts = new Database.DMLOptions();
        opts.duplicateRuleHeader.allowSave = true;
        return opts;
    }

    private static Boolean hasAddress(Address a) {
        return a != null && String.isNotBlank(a.street) && String.isNotBlank(a.city) && String.isNotBlank(a.country);
    }

    private static void applyAddresses(Account a, CustomerRequest req) {
        Address b = req.billing;
        Address s = hasAddress(req.shipping) ? req.shipping : req.billing;
        if (hasAddress(b)) {
            a.BillingStreet = b.street;
            a.BillingCity = b.city;
            a.BillingState = b.state;
            a.BillingPostalCode = b.postalCode;
            a.BillingCountry = b.country;
        }
        if (hasAddress(s)) {
            a.ShippingStreet = s.street;
            a.ShippingCity = s.city;
            a.ShippingState = s.state;
            a.ShippingPostalCode = s.postalCode;
            a.ShippingCountry = s.country;
        }
    }

    private static String newAccountName(CustomerRequest req) {
        if (req.individual == true || String.isBlank(req.company)) {
            return ('Individual - ' + String.join(new List<String>{ req.firstName, req.lastName }, ' ').trim()).left(120);
        }
        return req.company.trim();
    }

    private static void notifyOwner(Account acc, Contact c) {
        try {
            insert as user new Task(
                OwnerId = acc.OwnerId,
                WhoId = c.Id,
                WhatId = acc.Id,
                Subject = 'Approve portal access: ' + c.FirstName + ' ' + c.LastName + ' (' + c.Email + ')',
                Description = 'A new colleague registered on the customer portal for ' + acc.Name + '. Set Portal Access to Active on the Contact to approve, or Rejected to decline.',
                ActivityDate = Date.today().addDays(2),
                Priority = 'High'
            );
            Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
            mail.setTargetObjectId(acc.OwnerId);
            mail.setSaveAsActivity(false);
            mail.setSubject('Portal access request for ' + acc.Name);
            mail.setPlainTextBody(c.FirstName + ' ' + c.LastName + ' (' + c.Email + ') asked for portal access to ' + acc.Name
                + '. Open the Contact and set Portal Access to Active to approve.');
            Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'Owner notification failed: ' + ex.getMessage());
        }
    }

    // ---------------------------------------------------------------- resolve

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

        if (!contacts.isEmpty()) {
            if (!leads.isEmpty()) convertLead(leads[0].Id, contacts[0].AccountId, contacts[0].Id);
            return payload(contacts[0].Id);
        }

        Account match = findAccount(req.email, req.company);
        if (match != null) {
            // a colleague of an existing company: needs only a name, and waits for the Account Owner
            Id contactId;
            if (!leads.isEmpty()) {
                contactId = convertLead(leads[0].Id, match.Id, null);
            } else if (String.isNotBlank(req.lastName)) {
                Contact created = new Contact(AccountId = match.Id, FirstName = req.firstName, LastName = req.lastName, Email = req.email, Phone = req.phone, LeadSource = 'Web');
                Database.insert(created, allowDuplicates(), AccessLevel.USER_MODE);
                contactId = created.Id;
            } else {
                return new Map<String, Object>{ 'needsProfile' => true, 'domainMatch' => true, 'accountName' => match.Name };
            }
            update as user new Contact(Id = contactId, Portal_Access__c = 'Pending', Portal_Account_Admin__c = false);
            notifyOwner(match, [SELECT Id, FirstName, LastName, Email FROM Contact WHERE Id = :contactId]);
            return payload(contactId);
        }

        // a new company: name, company (or "individual") and a billing address are required
        Boolean complete = String.isNotBlank(req.lastName) && (String.isNotBlank(req.company) || req.individual == true) && hasAddress(req.billing);
        if (!complete) return new Map<String, Object>{ 'needsProfile' => true, 'domainMatch' => false };

        Id newContactId;
        if (!leads.isEmpty()) {
            newContactId = convertLead(leads[0].Id, null, null);
            Account acc = [SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Id = :newContactId) LIMIT 1];
            acc.Name = newAccountName(req);
            applyAddresses(acc, req);
            update as user acc;
        } else {
            Account acc = new Account(Name = newAccountName(req));
            applyAddresses(acc, req);
            Database.insert(acc, allowDuplicates(), AccessLevel.USER_MODE);
            Contact created = new Contact(AccountId = acc.Id, FirstName = req.firstName, LastName = req.lastName, Email = req.email, Phone = req.phone, LeadSource = 'Web');
            Database.insert(created, allowDuplicates(), AccessLevel.USER_MODE);
            newContactId = created.Id;
        }
        update as user new Contact(Id = newContactId, Portal_Access__c = 'Active', Portal_Account_Admin__c = true);
        return payload(newContactId);
    }

    private static Id convertLead(Id leadId, Id accountId, Id contactId) {
        Database.LeadConvert lc = new Database.LeadConvert();
        lc.setLeadId(leadId);
        lc.setConvertedStatus([SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1].MasterLabel);
        lc.setDoNotCreateOpportunity(true); // the quote flow creates or reuses the Opportunity
        if (accountId != null) lc.setAccountId(accountId);
        if (contactId != null) lc.setContactId(contactId);
        Database.LeadConvertResult r = Database.convertLead(lc);
        if (!r.isSuccess()) throw new IllegalArgumentException('Could not convert the lead: ' + r.getErrors()[0].getMessage());
        return r.getContactId();
    }

    // ---------------------------------------------------------------- status / profile

    @TestVisible
    private static Map<String, Object> payload(Id contactId) {
        Contact c = [
            SELECT Id, FirstName, LastName, Email, AccountId, Account.Name, Portal_Access__c, Portal_Account_Admin__c
            FROM Contact
            WHERE Id = :contactId
            LIMIT 1
        ];
        String access = String.isBlank(c.Portal_Access__c) ? 'Active' : c.Portal_Access__c;
        return new Map<String, Object>{
            'contactId' => c.Id,
            'accountId' => c.AccountId,
            'accountName' => c.Account.Name,
            'name' => String.join(new List<String>{ c.FirstName, c.LastName }, ' ').trim(),
            'email' => c.Email,
            'access' => access,
            'isAdmin' => access == 'Active' && c.Portal_Account_Admin__c == true
        };
    }

    private static Map<String, Object> addr(String street, String city, String state, String postal, String country) {
        return new Map<String, Object>{ 'street' => street, 'city' => city, 'state' => state, 'postalCode' => postal, 'country' => country };
    }

    @TestVisible
    private static Map<String, Object> profile(Id contactId) {
        Contact c = [
            SELECT Id, FirstName, LastName, Email, Phone, Portal_Access__c, Portal_Account_Admin__c,
                   Account.Name, Account.BillingStreet, Account.BillingCity, Account.BillingState, Account.BillingPostalCode, Account.BillingCountry,
                   Account.ShippingStreet, Account.ShippingCity, Account.ShippingState, Account.ShippingPostalCode, Account.ShippingCountry
            FROM Contact
            WHERE Id = :contactId
            LIMIT 1
        ];
        Boolean active = String.isBlank(c.Portal_Access__c) || c.Portal_Access__c == 'Active';
        Map<String, Object> out = new Map<String, Object>{
            'firstName' => c.FirstName, 'lastName' => c.LastName, 'email' => c.Email, 'phone' => c.Phone,
            'accountName' => c.Account.Name, 'access' => active ? 'Active' : c.Portal_Access__c,
            'canEditAccount' => active && c.Portal_Account_Admin__c == true
        };
        if (active) {
            out.put('billing', addr(c.Account.BillingStreet, c.Account.BillingCity, c.Account.BillingState, c.Account.BillingPostalCode, c.Account.BillingCountry));
            out.put('shipping', addr(c.Account.ShippingStreet, c.Account.ShippingCity, c.Account.ShippingState, c.Account.ShippingPostalCode, c.Account.ShippingCountry));
        }
        return out;
    }

    @TestVisible
    private static Map<String, Object> saveProfile(CustomerRequest req) {
        Id contactId = requireContact(req);
        Contact c = [SELECT Id, AccountId, Portal_Access__c, Portal_Account_Admin__c FROM Contact WHERE Id = :contactId LIMIT 1];
        if (String.isBlank(req.lastName)) throw new IllegalArgumentException('Last name is required');
        update as user new Contact(Id = c.Id, FirstName = req.firstName, LastName = req.lastName, Phone = req.phone);

        Boolean active = String.isBlank(c.Portal_Access__c) || c.Portal_Access__c == 'Active';
        if (active && c.Portal_Account_Admin__c == true && (req.billing != null || req.shipping != null)) {
            if (!hasAddress(req.billing)) throw new IllegalArgumentException('A billing address (street, city, country) is required');
            Account acc = new Account(Id = c.AccountId);
            applyAddresses(acc, req);
            update as user acc;
        }
        return profile(c.Id);
    }
}
