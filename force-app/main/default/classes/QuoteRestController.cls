/**
 * QuoteRestController
 * ---------------------------------------------------------------------------
 * REST API for the standard Quote object, used by the web app's Cart, Quotes
 * and QuoteDetails pages.
 *
 * Base URL (after your domain):
 *   /services/apexrest/api/quotes/           -> list / create
 *   /services/apexrest/api/quotes/{quoteId}  -> get one / update / delete
 *
 * Methods:
 *   GET    /api/quotes/            -> list all quotes (summary)
 *   GET    /api/quotes/{id}        -> quote detail + line items (products)
 *   POST   /api/quotes/            -> create a Quote (+ QuoteLineItems) from a cart
 *   PATCH  /api/quotes/{id}        -> update Status, notes, Quote Source, Tax,
 *                                      ShippingHandling, and/or the full set of
 *                                      line items (Cart/QuoteDetails "Update Quote")
 *   DELETE /api/quotes/{id}        -> delete a quote
 *
 * Setup notes (do this once in the org):
 *   1. Deploy this class and expose it to your Connected App via a Permission Set.
 *   2. The Permission Set / running user needs:
 *        - Object perms: Create/Read/Edit/Delete on Quote & QuoteLineItem,
 *          Read on Opportunity, Account, Product2, PricebookEntry, Pricebook2.
 *        - Field-level security on all fields referenced below, including the
 *          custom Quote_Source__c picklist field.
 *   3. Standard Quote requires an Opportunity (master-detail). If the caller
 *      doesn't send one, this class auto-creates/reuses a placeholder
 *      Account/Opportunity ("Web Store Customer" / "Web Store Quotes") so the
 *      Cart -> Create Quote flow works without an Opportunity picker in the UI.
 *      Replace resolveOrCreateDefaultOpportunity() once real Opportunities
 *      are wired into the app.
 *   4. A Quote's line items must use PricebookEntries from the SAME Pricebook2
 *      as the Quote/Opportunity. This class always assigns the org's Standard
 *      Price Book to both the placeholder Opportunity and the Quote itself
 *      (see getStandardPricebookId() / ensureOpportunityHasPricebook()) so
 *      Standard Price Book line items always match.
 *   5. The Quote.Status picklist must contain the values used by the UI:
 *      Draft, Pending, Approved, Rejected, Converted (add "Converted" as a
 *      custom picklist value if it doesn't already exist).
 *   6. The Quote.Quote_Source__c picklist must contain the values used by
 *      the UI: "Web" and "Sales Representative". Quotes created through this
 *      API always default to "Web" unless the caller explicitly supplies a
 *      different value (e.g. an internal sales-rep tool sending
 *      "Sales Representative").
 *   7. If a product's selling model is Evergreen or Term-Defined (Salesforce
 *      Billing/Revenue Cloud), QuoteLineItem.BillingFrequency becomes required
 *      but CANNOT be set via API unless the line item already has a related
 *      Billing Treatment record - leaving it null throws
 *      FIELD_INTEGRITY_EXCEPTION, and setting it throws
 *      INVALID_FIELD_FOR_INSERT_UPDATE. This cannot be worked around in Apex.
 *      For a simple web-store quote flow, change the product's selling model
 *      (Product2 -> Selling Models related list / ProductSellingModelOption)
 *      to a One-time model so BillingFrequency is never required. Only use a
 *      subscription selling model if you've also set up Billing Treatments.
 *   8. MULTI-CURRENCY ORGS: a Quote's QuoteLineItems must use a
 *      PricebookEntry whose CurrencyIsoCode matches the Quote's own
 *      CurrencyIsoCode, or insert throws FIELD_INTEGRITY_EXCEPTION ("The
 *      price book entry currency code is different than the one assigned to
 *      the Quote"). This class re-queries the Quote right after insert (and
 *      before any line-item replace on PATCH) to find out which currency it
 *      actually landed on, then only selects PricebookEntries in that same
 *      currency. Make sure every product you sell through the web store has
 *      an ACTIVE Standard Price Book entry in every currency your users can
 *      quote in - otherwise line item insert will fail with a clear
 *      "no active <CURRENCY> price book entry" error telling you which
 *      product/currency combo is missing.
 *   9. PATCH line-item replacement uses a delete-and-recreate strategy
 *      (delete all existing QuoteLineItems for the quote, then insert the
 *      new set) rather than trying to diff and update in place. This mirrors
 *      the same fallback pattern used for the Survey module's Matrix/Grid
 *      persistence, and avoids having to match up which incoming row
 *      corresponds to which existing QuoteLineItem Id.
 *  10. The QuoteDetails page's "Update" button (shown for Draft/Pending
 *      quotes only) lets the user change line item quantities and add new
 *      products before the quote is approved. When saved, it sends the FULL
 *      new line-item set plus recalculated tax/shippingHandling via PATCH -
 *      see QuoteUpdateWrapper.tax / .shippingHandling below.
 */
@RestResource(urlMapping='/api/quotes/*')
global with sharing class QuoteRestController {

    // Allowed Quote_Source__c values. Requests are always defaulted to WEB
    // unless the caller explicitly supplies SALES_REP - there is no picklist
    // value the frontend needs to send other than these two.
    private static final String QUOTE_SOURCE_WEB = 'Web';
    private static final String QUOTE_SOURCE_SALES_REP = 'Sales Representative';
    private static final Set<String> VALID_QUOTE_SOURCES = new Set<String>{ QUOTE_SOURCE_WEB, QUOTE_SOURCE_SALES_REP };

    // Statuses from which the QuoteDetails "Update" flow is still allowed.
    // Once a quote reaches Approved (or beyond - Rejected/Converted), line
    // items can no longer be replaced through PATCH.
    private static final Set<String> EDITABLE_STATUSES = new Set<String>{ 'Draft', 'Pending' };

    // Portal customers (requests carrying a contactId) may only change a quote's lines while it is Draft.
    // Any later status is changed by creating a revision (a new quote on the same Opportunity).
    private static final Set<String> CUSTOMER_EDITABLE_STATUSES = new Set<String>{ 'Draft' };

    // What a signed-in customer may do to a quote, and from which statuses.
    //   Needs Review = customer submitted it for pricing review; Accepted = customer accepted an approved quote;
    //   Denied = customer is not interested. Superseded is set automatically when a revision replaces a quote.
    private static final Map<String, Set<String>> CUSTOMER_TRANSITIONS = new Map<String, Set<String>>{
        'Needs Review' => new Set<String>{ 'Draft' },
        'Accepted' => new Set<String>{ 'Approved', 'Presented' },
        'Denied' => new Set<String>{ 'Draft', 'Needs Review', 'In Review', 'Approved', 'Presented', 'Rejected' }
    };
    private static final Set<String> SUPERSEDABLE = new Set<String>{ 'Needs Review', 'In Review', 'Approved', 'Presented', 'Rejected' };

    // An open web Opportunity is reused for the same customer only if it was touched within this many days.
    private static final Integer OPPORTUNITY_REUSE_DAYS = 90;

    // ============================= GET =====================================
    // /api/quotes/            -> list
    // /api/quotes/{quoteId}   -> single quote detail
    @HttpGet
    global static void handleGet() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        String quoteId = getIdFromUri(RestContext.request.requestURI);
        String contactId = RestContext.request.params.get('contactId');

        try {
            if (String.isNotBlank(quoteId)) {
                assertOwnedBy(quoteId, contactId, true);
                res.responseBody = Blob.valueOf(JSON.serialize(getQuoteDetail(quoteId)));
            } else {
                // never list every quote: the list is always scoped to one customer contact (or, for an Account Admin, their Account)
                if (String.isBlank(contactId)) throw new QuoteApiException('contactId is required to list quotes');
                res.responseBody = Blob.valueOf(JSON.serialize(getQuoteList(contactId, RestContext.request.params.get('scope') == 'account')));
            }
        } catch (Exception ex) {
            writeError(res, 400, ex.getMessage());
        }
    }

    // ============================= POST ====================================
    // /api/quotes/  -> create a Quote from the cart (products become QuoteLineItems)
    @HttpPost
    global static void handlePost() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        Savepoint sp = Database.setSavepoint(); // a failed create leaves nothing behind

        try {
            String rawBody = RestContext.request.requestBody.toString();
            QuoteRequestWrapper body = (QuoteRequestWrapper) JSON.deserialize(rawBody, QuoteRequestWrapper.class);

            // Resolve (or create) the Opportunity this Quote will hang off of,
            // and make sure it has the Standard Price Book assigned. A Quote's
            // line items can only use PricebookEntries from the same Pricebook2
            // as the Opportunity/Quote, so this has to happen before insert.
            Contact customer = null;
            if (String.isNotBlank(body.contactId)) {
                customer = portalContact(body.contactId);
                assertActive(customer);
            }
            Id oppId;
            if (String.isNotBlank(body.contactId)) {
                oppId = resolveOpportunityForContact(body.contactId, body.opportunityId, body.currencyCode);
            } else {
                oppId = String.isNotBlank(body.opportunityId) ? body.opportunityId : resolveOrCreateDefaultOpportunity();
            }
            ensureOpportunityHasPricebook(oppId); // covers caller-supplied opportunityId too

            Quote q = new Quote();
            q.Name             = String.isNotBlank(body.name) ? body.name : 'Web Quote ' + DateTime.now().format('yyyy-MM-dd HH:mm');
            q.OpportunityId     = oppId;
            if (String.isNotBlank(body.contactId)) {
                q.ContactId = body.contactId;
                copyAccountAddresses(q, customer);
            }
            q.Pricebook2Id      = getStandardPricebookId(); // set directly - don't rely on Opportunity->Quote sync via API
            q.Status            = String.isNotBlank(body.status) ? body.status : 'Draft';
            q.Description        = body.notes;
            q.ExpirationDate      = body.expirationDate;
            // Quote Source: every quote created through this REST API is
            // created "through the website", so this defaults to Web. It is
            // only ever anything else if a caller explicitly passes a valid
            // alternate value (e.g. "Sales Representative" from an internal tool).
            q.Quote_Source__c     = resolveQuoteSource(body.quoteSource);
            // NOTE: Quote.Discount is not directly writeable in this org - it's
            // calculated from QuoteLineItem-level discounts, so it's intentionally
            // left off the insert. Set discounts on the line items instead if needed.
            q.ShippingHandling    = body.shippingHandling;
            q.Tax                 = body.tax;
            insert q;

            // Multi-currency org: CurrencyIsoCode was NOT set above, so it
            // defaulted to the running user's currency at insert time. Find
            // out what it actually is so line items can be matched to a
            // PricebookEntry in the SAME currency - guessing/assuming here
            // is exactly what causes FIELD_INTEGRITY_EXCEPTION on insert.
            Quote insertedQuote = [SELECT Id, CurrencyIsoCode FROM Quote WHERE Id = :q.Id LIMIT 1];
            if (String.isNotBlank(body.currencyCode) && insertedQuote.CurrencyIsoCode != body.currencyCode) {
                throw new QuoteApiException(
                    'The quote currency (' + insertedQuote.CurrencyIsoCode + ') does not match the requested currency (' + body.currencyCode + ').'
                );
            }

            if (body.lineItems != null && !body.lineItems.isEmpty()) {
                insertLineItems(q.Id, body.lineItems, insertedQuote.CurrencyIsoCode);
            }

            // a revision replaces the quote it was made from
            if (String.isNotBlank(body.contactId) && String.isNotBlank(body.supersedes)) {
                assertOwnedBy(body.supersedes, body.contactId, true);
                Quote old = [SELECT Id, Status FROM Quote WHERE Id = :body.supersedes LIMIT 1];
                if (SUPERSEDABLE.contains(old.Status)) {
                    old.Status = 'Superseded';
                    update old;
                }
            }

            res.statusCode = 201;
            res.responseBody = Blob.valueOf(JSON.serialize(getQuoteDetail(q.Id)));
        } catch (Exception ex) {
            Database.rollback(sp);
            writeError(res, 400, ex.getMessage());
        }
    }

    // ============================= PATCH ===================================
    // /api/quotes/{quoteId} -> update Status, notes, Quote Source, Tax,
    // ShippingHandling, and/or the full line-item set. Used by:
    //   - Cart's "Update Quote" flow (quantities/products changed pre-approval)
    //   - QuoteDetails' "Update" button (same thing, from the detail page)
    @HttpPatch
    global static void handlePatch() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        String quoteId = getIdFromUri(RestContext.request.requestURI);
        String contactId = RestContext.request.params.get('contactId');
        Savepoint sp = Database.setSavepoint(); // delete-and-reinsert of lines is all or nothing

        try {
            if (String.isBlank(quoteId)) {
                throw new QuoteApiException('Quote Id is required in the URL, e.g. /api/quotes/{id}');
            }
            assertOwnedBy(quoteId, contactId, false); // only the owner changes a quote (an Account Admin may view and revise)
            String rawBody = RestContext.request.requestBody.toString();
            QuoteUpdateWrapper body = (QuoteUpdateWrapper) JSON.deserialize(rawBody, QuoteUpdateWrapper.class);
            if (String.isNotBlank(contactId)) {
                // customers never set money fields or the quote source
                body.tax = null;
                body.shippingHandling = null;
                body.quoteSource = null;
                if (String.isNotBlank(body.status)) checkCustomerTransition(quoteId, body.status);
            }

            Boolean replacingLineItems = body.lineItems != null;

            // Line items (quantities/products) can only be replaced while the
            // quote is still Draft or Pending. Once Approved/Rejected/Converted,
            // the quote is locked from further product edits - this mirrors the
            // "Update" button only being shown on those two statuses in the UI,
            // but is enforced here too so the rule holds even if called directly.
            if (replacingLineItems) {
                Quote existing = [SELECT Id, Status FROM Quote WHERE Id = :quoteId LIMIT 1];
                Set<String> editable = String.isNotBlank(contactId) ? CUSTOMER_EDITABLE_STATUSES : EDITABLE_STATUSES;
                if (!editable.contains(existing.Status)) {
                    throw new QuoteApiException(
                        'Line items can no longer be changed once a quote is "' + existing.Status +
                        '". Only ' + String.join(new List<String>(editable), ' or ') + ' quotes can have their products/quantities updated.'
                    );
                }
            }

            Quote q = new Quote(Id = quoteId);
            Boolean hasChange = false;
            if (String.isNotBlank(body.status)) { q.Status = body.status; hasChange = true; }
            if (body.notes != null)             { q.Description = body.notes; hasChange = true; }
            if (String.isNotBlank(body.quoteSource)) {
                q.Quote_Source__c = resolveQuoteSource(body.quoteSource);
                hasChange = true;
            }
            // Tax and ShippingHandling are plain currency fields (not rollups),
            // so when the QuoteDetails "Update" flow recalculates tax after the
            // user changes quantities/products, it must send the new values
            // explicitly - they will NOT recompute on their own.
            if (body.tax != null)              { q.Tax = body.tax; hasChange = true; }
            if (body.shippingHandling != null) { q.ShippingHandling = body.shippingHandling; hasChange = true; }

            if (!hasChange && !replacingLineItems) {
                throw new QuoteApiException('Nothing to update. Provide "status", "notes", "quoteSource", "tax", "shippingHandling" and/or "lineItems".');
            }
            if (hasChange) {
                update q;
            }
            if (hasChange && String.isNotBlank(contactId) && String.isNotBlank(body.status)) {
                QuoteStageSync.apply(quoteId); // Opportunity follows the quote (not done in the Quote trigger: Salesforce forbids it)
            }

            if (replacingLineItems) {
                replaceLineItems(quoteId, body.lineItems);
            }

            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(getQuoteDetail(quoteId)));
        } catch (Exception ex) {
            Database.rollback(sp);
            writeError(res, 400, ex.getMessage());
        }
    }

    // ============================= DELETE ==================================
    // /api/quotes/{quoteId} -> delete a quote
    @HttpDelete
    global static void handleDelete() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        String quoteId = getIdFromUri(RestContext.request.requestURI);

        try {
            if (String.isBlank(quoteId)) {
                throw new QuoteApiException('Quote Id is required in the URL, e.g. /api/quotes/{id}');
            }
            assertOwnedBy(quoteId, RestContext.request.params.get('contactId'), false);
            delete new Quote(Id = quoteId);
            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{ 'success' => true, 'id' => quoteId }));
        } catch (Exception ex) {
            writeError(res, 400, ex.getMessage());
        }
    }

    // =========================== helpers ===================================

    private static void writeError(RestResponse res, Integer statusCode, String message) {
        res.statusCode = statusCode;
        res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, String>{ 'error' => message }));
    }

    // Pulls a 15/18-char Salesforce Id off the end of the request URI, if present.
    private static String getIdFromUri(String uri) {
        if (String.isBlank(uri)) return null;
        List<String> parts = uri.split('/');
        String last = parts[parts.size() - 1];
        if (String.isBlank(last)) return null;
        return (last.length() == 15 || last.length() == 18) ? last : null;
    }

    // Normalizes/validates an incoming quoteSource value. Falls back to Web
    // (the correct default for anything created through the website) if the
    // caller didn't send one, and rejects anything that isn't a real picklist
    // value rather than silently writing garbage to Quote_Source__c.
    private static String resolveQuoteSource(String requested) {
        if (String.isBlank(requested)) return QUOTE_SOURCE_WEB;
        if (!VALID_QUOTE_SOURCES.contains(requested)) {
            throw new QuoteApiException(
                'Invalid quoteSource "' + requested + '". Must be one of: ' + String.join(new List<String>(VALID_QUOTE_SOURCES), ', ')
            );
        }
        return requested;
    }

    // Cached lookup for the org's Standard Price Book Id - a Quote and every
    // QuoteLineItem on it must reference PricebookEntries from this same book
    // (or whichever Pricebook2 is assigned to the Quote's Opportunity).
    private static Id cachedStandardPricebookId;
    private static Id getStandardPricebookId() {
        if (cachedStandardPricebookId == null) {
            cachedStandardPricebookId = Test.isRunningTest()
                ? Test.getStandardPricebookId()
                : [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1].Id;
        }
        return cachedStandardPricebookId;
    }

    // Make sure ANY opportunity used for a quote (caller-supplied or the
    // auto-created placeholder) has the Standard Price Book assigned. A Quote
    // can only use PricebookEntries from the same Pricebook2 as its
    // Opportunity - this is what FIELD_INTEGRITY_EXCEPTION on QuoteLineItem
    // insert is complaining about when it's missing.
    private static void ensureOpportunityHasPricebook(Id oppId) {
        Opportunity opp = [SELECT Id, Pricebook2Id FROM Opportunity WHERE Id = :oppId LIMIT 1];
        if (opp.Pricebook2Id == null) {
            opp.Pricebook2Id = getStandardPricebookId();
            update opp;
        }
    }

    // The signed-in customer, with the Account addresses that are copied onto their quotes.
    private static Contact portalContact(Id contactId) {
        List<Contact> found = [
            SELECT Id, AccountId, Portal_Access__c, Portal_Account_Admin__c, Account.Name,
                   Account.BillingStreet, Account.BillingCity, Account.BillingState, Account.BillingPostalCode, Account.BillingCountry,
                   Account.ShippingStreet, Account.ShippingCity, Account.ShippingState, Account.ShippingPostalCode, Account.ShippingCountry
            FROM Contact
            WHERE Id = :contactId
            LIMIT 1
        ];
        if (found.isEmpty()) throw new QuoteApiException('Customer not found');
        return found[0];
    }

    // A colleague waiting for the Account Owner's approval cannot use quotes. Empty Portal Access counts as Active.
    private static void assertActive(Contact c) {
        if (String.isNotBlank(c.Portal_Access__c) && c.Portal_Access__c != 'Active') {
            throw new QuoteApiException('Your access is waiting for approval from your account owner.');
        }
    }

    private static void copyAccountAddresses(Quote q, Contact c) {
        q.BillingName = c.Account.Name;
        q.BillingStreet = c.Account.BillingStreet;
        q.BillingCity = c.Account.BillingCity;
        q.BillingState = c.Account.BillingState;
        q.BillingPostalCode = c.Account.BillingPostalCode;
        q.BillingCountry = c.Account.BillingCountry;
        q.ShippingName = c.Account.Name;
        q.ShippingStreet = c.Account.ShippingStreet;
        q.ShippingCity = c.Account.ShippingCity;
        q.ShippingState = c.Account.ShippingState;
        q.ShippingPostalCode = c.Account.ShippingPostalCode;
        q.ShippingCountry = c.Account.ShippingCountry;
    }

    // A quote may only be touched by the customer contact it belongs to. When allowAdmin is true, an active Portal
    // Account Admin of the same Account may also see it. When no contactId is supplied the call is an internal one
    // (the old behaviour). A mismatch looks exactly like a missing quote.
    private static void assertOwnedBy(Id quoteId, String contactId, Boolean allowAdmin) {
        if (String.isBlank(contactId)) return;
        Contact c = portalContact(contactId);
        assertActive(c);
        List<Quote> found = [SELECT ContactId, Contact.AccountId FROM Quote WHERE Id = :quoteId LIMIT 1];
        Boolean ok = !found.isEmpty() && (
            found[0].ContactId == c.Id ||
            (allowAdmin && c.Portal_Account_Admin__c == true && found[0].Contact.AccountId == c.AccountId)
        );
        if (!ok) throw new QuoteApiException('Quote not found: ' + quoteId);
    }

    private static void checkCustomerTransition(Id quoteId, String newStatus) {
        Set<String> allowedFrom = CUSTOMER_TRANSITIONS.get(newStatus);
        Quote current = [SELECT Status, LineItemCount FROM Quote WHERE Id = :quoteId LIMIT 1];
        if (allowedFrom == null || !allowedFrom.contains(current.Status)) {
            throw new QuoteApiException('That action is not available for a quote that is "' + current.Status + '".');
        }
        if (newStatus == 'Needs Review' && (current.LineItemCount == null || current.LineItemCount < 1)) {
            throw new QuoteApiException('Add at least one product before submitting the quote for review.');
        }
    }

    // Opportunity rules for a signed-in customer:
    //  - a given opportunityId (a revision) is used only if it belongs to the customer's Account;
    //  - otherwise REUSE the customer's most recent OPEN, web-sourced Opportunity in the same currency that has
    //    this contact on it and was touched in the last OPPORTUNITY_REUSE_DAYS days;
    //  - otherwise CREATE a new one (with this contact as its contact role).
    @TestVisible
    private static Id resolveOpportunityForContact(Id contactId, String requestedOppId, String currencyCode) {
        Contact c = [SELECT Id, AccountId, Account.Name FROM Contact WHERE Id = :contactId LIMIT 1];
        if (c.AccountId == null) throw new QuoteApiException('The customer contact has no account.');

        if (String.isNotBlank(requestedOppId)) {
            Integer own = [SELECT COUNT() FROM Opportunity WHERE Id = :requestedOppId AND AccountId = :c.AccountId];
            if (own == 0) throw new QuoteApiException('Opportunity not found: ' + requestedOppId);
            ensureOpportunityHasPricebook(requestedOppId);
            return requestedOppId;
        }

        String cur = String.isNotBlank(currencyCode) ? currencyCode : UserInfo.getDefaultCurrency();
        Datetime cutoff = Datetime.now().addDays(-OPPORTUNITY_REUSE_DAYS);
        List<Opportunity> reusable = [
            SELECT Id
            FROM Opportunity
            WHERE AccountId = :c.AccountId
              AND IsClosed = false
              AND LeadSource = 'Web'
              AND CurrencyIsoCode = :cur
              AND LastModifiedDate >= :cutoff
              AND Id IN (SELECT OpportunityId FROM OpportunityContactRole WHERE ContactId = :c.Id)
            ORDER BY LastModifiedDate DESC
            LIMIT 1
        ];
        if (!reusable.isEmpty()) {
            ensureOpportunityHasPricebook(reusable[0].Id);
            return reusable[0].Id;
        }

        Opportunity opp = new Opportunity(
            Name         = ('Web enquiry - ' + c.Account.Name + ' - ' + Date.today().format()).left(120),
            AccountId    = c.AccountId,
            StageName    = 'Proposal/Price Quote',
            CloseDate    = Date.today().addDays(30),
            LeadSource   = 'Web',
            Pricebook2Id = getStandardPricebookId(),
            CurrencyIsoCode = cur
        );
        insert opp;
        insert new OpportunityContactRole(OpportunityId = opp.Id, ContactId = c.Id, IsPrimary = true);
        return opp.Id;
    }

    // Replaces the full set of QuoteLineItems on a quote: delete everything
    // that's there today, then insert the incoming set fresh. Used by PATCH
    // when the Cart or QuoteDetails page sends an updated set (quantities
    // changed, items added or removed) rather than trying to diff old vs. new
    // rows.
    private static void replaceLineItems(Id quoteId, List<QuoteLineItemWrapper> items) {
        delete [SELECT Id FROM QuoteLineItem WHERE QuoteId = :quoteId];

        if (items == null || items.isEmpty()) return;

        Quote q = [SELECT Id, CurrencyIsoCode FROM Quote WHERE Id = :quoteId LIMIT 1];
        insertLineItems(quoteId, items, q.CurrencyIsoCode);
    }

    private static void insertLineItems(Id quoteId, List<QuoteLineItemWrapper> items, String currencyIsoCode) {
        // Surface blank/missing product ids from the request immediately - this is
        // a payload problem (frontend), not a pricing problem, and should never be
        // silently folded into the "no pricebook entry" case.
        List<Integer> blankProductIdIndexes = new List<Integer>();
        for (Integer i = 0; i < items.size(); i++) {
            if (String.isBlank(items[i].productId)) blankProductIdIndexes.add(i);
        }
        if (!blankProductIdIndexes.isEmpty()) {
            throw new QuoteApiException(
                'lineItems[' + String.join(blankProductIdIndexes, ', ') + '].productId is blank. ' +
                'The frontend must send the Product2 Id (the same "id" shown on the Products page) for every cart item.'
            );
        }

        Set<String> productIds = new Set<String>();
        for (QuoteLineItemWrapper li : items) productIds.add(li.productId);

        // Always use the org's Standard Price Book, as requested. In a
        // multi-currency org a single product can have more than one active
        // Standard Price Book entry - one per currency - so we MUST filter
        // by CurrencyIsoCode too. A QuoteLineItem's PricebookEntry currency
        // has to match its Quote's currency or insert throws
        // FIELD_INTEGRITY_EXCEPTION.
        Map<String, Id> pbeByProduct = new Map<String, Id>();
        for (PricebookEntry pbe : [
            SELECT Id, Product2Id
            FROM PricebookEntry
            WHERE Product2Id IN :productIds
              AND IsActive = true
              AND Pricebook2.IsStandard = true
              AND CurrencyIsoCode = :currencyIsoCode
        ]) {
            pbeByProduct.put(pbe.Product2Id, pbe.Id);
        }

        List<QuoteLineItem> toInsert = new List<QuoteLineItem>();
        List<String> missingProductIds = new List<String>();

        for (QuoteLineItemWrapper li : items) {
            Id pbeId = pbeByProduct.get(li.productId);
            if (pbeId == null) {
                missingProductIds.add(li.productId);
                continue;
            }
            QuoteLineItem qli = new QuoteLineItem();
            qli.QuoteId          = quoteId;
            qli.PricebookEntryId = pbeId;
            qli.Product2Id       = li.productId; // some orgs expose Product2Id directly on QuoteLineItem
            qli.Quantity         = li.quantity != null ? li.quantity : 1;
            qli.UnitPrice        = li.unitPrice;

            // NOTE: BillingFrequency is intentionally NOT set here. In this org it's
            // gated by Salesforce Billing's "Billing Treatment" object - setting it
            // without a Billing Treatment throws INVALID_FIELD_FOR_INSERT_UPDATE,
            // while leaving it null on an Evergreen/Term-Defined selling model throws
            // FIELD_INTEGRITY_EXCEPTION. This can't be resolved from Apex alone; fix
            // it by changing the product's selling model (Product2 -> Selling Models
            // related list) to a One-time model, or by setting up a Billing Treatment
            // if subscription billing is actually needed.

            toInsert.add(qli);
        }

        if (!missingProductIds.isEmpty() && toInsert.isEmpty()) {
            throw new QuoteApiException(
                'No active ' + currencyIsoCode + ' Standard Price Book entry found for product(s): ' +
                String.join(missingProductIds, ', ') +
                '. Add these products to the Standard Price Book in ' + currencyIsoCode +
                ' (and activate the entry) before quoting them.'
            );
        }

        if (toInsert.isEmpty()) return;

        try {
            insert toInsert;
        } catch (System.DmlException dmlEx) {
            // Some orgs derive Product2Id from PricebookEntryId and don't allow writing
            // it directly - if that's the failure, retry without it.
            if (dmlEx.getMessage().contains('Product2Id')) {
                for (QuoteLineItem qli : toInsert) qli.Product2Id = null;
                insert toInsert;
            } else {
                throw dmlEx;
            }
        }
    }

    // Standard Quote requires an Opportunity. Reuse/create a placeholder one
    // so the app can create quotes without an Opportunity picker in the UI.
    // Always ensures the Standard Price Book is assigned, since Quotes can
    // only reference PricebookEntries from their Opportunity's Pricebook2.
    private static Id resolveOrCreateDefaultOpportunity() {
        Id stdPbId = getStandardPricebookId();

        List<Opportunity> opps = [SELECT Id, Pricebook2Id FROM Opportunity WHERE Name = 'Web Store Quotes' LIMIT 1];
        if (!opps.isEmpty()) {
            if (opps[0].Pricebook2Id == null) {
                opps[0].Pricebook2Id = stdPbId;
                update opps[0];
            }
            return opps[0].Id;
        }

        Account acc;
        List<Account> accs = [SELECT Id FROM Account WHERE Name = 'Web Store Customer' LIMIT 1];
        if (!accs.isEmpty()) {
            acc = accs[0];
        } else {
            acc = new Account(Name = 'Web Store Customer');
            insert acc;
        }

        Opportunity opp = new Opportunity(
            Name         = 'Web Store Quotes',
            AccountId    = acc.Id,
            StageName    = 'Proposal/Price Quote',
            CloseDate    = Date.today().addDays(30),
            Pricebook2Id = stdPbId
        );
        insert opp;
        return opp.Id;
    }

    private static List<QuoteSummaryDTO> getQuoteList(Id contactId, Boolean wholeAccount) {
        Contact c = portalContact(contactId);
        assertActive(c);
        List<Quote> rows;
        if (wholeAccount && c.Portal_Account_Admin__c == true) {
            Id accountId = c.AccountId;
            rows = [
                SELECT Id, QuoteNumber, Name, Status, Quote_Source__c, GrandTotal, Subtotal, Tax, ShippingHandling, TotalPrice,
                       CreatedDate, LineItemCount, CurrencyIsoCode, ContactId, Contact.Name
                FROM Quote
                WHERE Contact.AccountId = :accountId
                ORDER BY CreatedDate DESC
                LIMIT 200
            ];
        } else {
            rows = [
                SELECT Id, QuoteNumber, Name, Status, Quote_Source__c, GrandTotal, Subtotal, Tax, ShippingHandling, TotalPrice,
                       CreatedDate, LineItemCount, CurrencyIsoCode, ContactId, Contact.Name
                FROM Quote
                WHERE ContactId = :c.Id
                ORDER BY CreatedDate DESC
                LIMIT 200
            ];
        }
        List<QuoteSummaryDTO> out = new List<QuoteSummaryDTO>();
        for (Quote q : rows) {
            out.add(new QuoteSummaryDTO(q));
        }
        return out;
    }

    private static QuoteDetailDTO getQuoteDetail(Id quoteId) {
        List<Quote> quotes = [
            SELECT Id, QuoteNumber, Name, Status, Quote_Source__c, Description, GrandTotal, Subtotal,
                   Tax, ShippingHandling, TotalPrice, TotalPriceWithTax, Discount,
                   CreatedDate, ExpirationDate, OpportunityId, CurrencyIsoCode
            FROM Quote
            WHERE Id = :quoteId
            LIMIT 1
        ];
        if (quotes.isEmpty()) throw new QuoteApiException('Quote not found: ' + quoteId);

        List<QuoteLineItem> lines = [
            SELECT Id, Quantity, UnitPrice, TotalPrice, Product2Id,
                   Product2.Name, Product2.Family, Product2.DisplayUrl
            FROM QuoteLineItem
            WHERE QuoteId = :quoteId
        ];
        return new QuoteDetailDTO(quotes[0], lines);
    }

    // =========================== request wrappers ==========================

    global class QuoteRequestWrapper {
        global String opportunityId;
        global String contactId;    // signed-in portal customer: the quote belongs to this contact
        global String supersedes;   // id of the quote this one is a revision of (it becomes Superseded)
        global String currencyCode; // currency the customer is buying in (must match the Opportunity/Quote)
        global String name;
        global String status;
        global String notes;
        global Date expirationDate;
        global Decimal discount;
        global Decimal shippingHandling;
        global Decimal tax;
        // "Web" or "Sales Representative". Omit this entirely for quotes
        // created through the website - it will default to "Web" automatically.
        global String quoteSource;
        global List<QuoteLineItemWrapper> lineItems;
    }

    global class QuoteLineItemWrapper {
        global String productId;   // Product2.Id (same Id the Products page shows)
        global Decimal quantity;
        global Decimal unitPrice;
        global String billingFrequency; // optional - only needed for Evergreen/Term-Defined products
    }

    global class QuoteUpdateWrapper {
        global String status;
        global String notes;
        global String quoteSource;
        // Recalculated by the frontend (18% GST of the new subtotal) whenever
        // lineItems changes via the QuoteDetails "Update" flow. Optional -
        // only sent/applied when the caller actually wants to change it.
        global Decimal tax;
        global Decimal shippingHandling;
        // When present (even as an empty array), the full line-item set on the
        // quote is replaced with this list. Used by Cart's "Update Quote" flow
        // and QuoteDetails' "Update" button. Only allowed while the quote is
        // still Draft or Pending - see EDITABLE_STATUSES.
        global List<QuoteLineItemWrapper> lineItems;
    }

    // =========================== response DTOs =============================

    global class QuoteSummaryDTO {
        global String id;
        global String quoteNumber;
        global String name;
        global String status;
        global String quoteSource;
        global Decimal grandTotal;
        global Decimal subtotal;
        global Decimal tax;
        global Decimal shippingHandling;
        global Integer itemCount;
        global String createdDate;
        global String currencyCode;
        global String ownerContactId;
        global String ownerName;

        global QuoteSummaryDTO(Quote q) {
            this.currencyCode      = q.CurrencyIsoCode;
            this.ownerContactId    = q.ContactId;
            this.ownerName         = q.Contact.Name;
            this.id               = q.Id;
            this.quoteNumber      = q.QuoteNumber;
            this.name             = q.Name;
            this.status           = q.Status;
            this.quoteSource       = q.Quote_Source__c;
            this.grandTotal        = q.GrandTotal;
            this.subtotal          = q.Subtotal;
            this.tax                = q.Tax;
            this.shippingHandling    = q.ShippingHandling;
            this.itemCount            = q.LineItemCount != null ? Integer.valueOf(q.LineItemCount) : 0;
            this.createdDate           = q.CreatedDate.format('yyyy-MM-dd');
        }
    }

    global class QuoteDetailDTO {
        global String id;
        global String quoteNumber;
        global String name;
        global String status;
        global String quoteSource;
        global String notes;
        global Decimal grandTotal;
        global Decimal subtotal;
        global Decimal tax;
        global Decimal shippingHandling;
        global Decimal totalPriceWithTax;
        global Decimal discount;
        global String createdDate;
        global String expirationDate;
        global String opportunityId;
        global String currencyCode;
        global List<QuoteLineDTO> products;

        global QuoteDetailDTO(Quote q, List<QuoteLineItem> lines) {
            this.currencyCode      = q.CurrencyIsoCode;
            this.id                = q.Id;
            this.quoteNumber       = q.QuoteNumber;
            this.name              = q.Name;
            this.status            = q.Status;
            this.quoteSource        = q.Quote_Source__c;
            this.notes             = q.Description;
            this.grandTotal        = q.GrandTotal;
            this.subtotal          = q.Subtotal;
            this.tax               = q.Tax;
            this.shippingHandling  = q.ShippingHandling;
            this.totalPriceWithTax = q.TotalPriceWithTax;
            this.discount          = q.Discount;
            this.createdDate       = q.CreatedDate.format('yyyy-MM-dd');
            this.expirationDate    = q.ExpirationDate != null ? String.valueOf(q.ExpirationDate) : null;
            this.opportunityId     = q.OpportunityId;

            this.products = new List<QuoteLineDTO>();
            for (QuoteLineItem li : lines) {
                this.products.add(new QuoteLineDTO(li));
            }
        }
    }

    global class QuoteLineDTO {
        global String id;
        global String productId;
        global String name;
        global String category;
        global String image;
        global Decimal qty;
        global Decimal price;

        global QuoteLineDTO(QuoteLineItem li) {
            this.id        = li.Id;
            this.productId = li.Product2Id;
            this.name      = li.Product2.Name;
            this.category  = li.Product2.Family;
            this.image     = li.Product2.DisplayUrl;
            this.qty       = li.Quantity;
            this.price     = li.UnitPrice;
        }
    }

    global class QuoteApiException extends Exception {}
}