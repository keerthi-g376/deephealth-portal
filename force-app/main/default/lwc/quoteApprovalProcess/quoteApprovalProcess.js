import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { CloseActionScreenEvent } from 'lightning/actions';
import submitQuoteForApproval from '@salesforce/apex/QuoteApprovalLWCController.submitQuoteForApproval';
export default class QuoteApproval extends LightningElement {
    @api recordId;
    submitterComments = '';
    handleCommentChange(event) {
        this.submitterComments = event.target.value;
    }
    async handleSubmit() {
        try {
            await submitQuoteForApproval({ quoteId: this.recordId, submitterComments: this.submitterComments });
            this.dispatchEvent(new ShowToastEvent({
                title: 'Success',
                message: 'Quote submitted for approval',
                variant: 'success'
            }));
            this.dispatchEvent(new CloseActionScreenEvent());
        } catch (error) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Error',
                message: error.body.message,
                variant: 'error'
            }));
        }
    }
    handleCancel() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}