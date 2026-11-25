import { describe, expect, it } from 'vitest';
import { activationDiff, approvalImpact, notificationChanges, publishPlan, statusImpact } from '../src/approval.js';

describe('what the person reads', () => {
  it('a reply-to address is shown whole', () => {
    const long = `${'a'.repeat(240)}@attacker.example`;
    expect(notificationChanges({ reply_to: { before: null, after: { kind: 'fixed', address: long } } })).toContain(long);
  });

  it('an approval that only registers an account does not claim an email', () => {
    const text = approvalImpact({ notifies_customer: true, approval: { from: 'pending', to: 'approved' }, notifications: [], registers_customer: true });
    expect(text).toBe('Approval pending → approved; registers a customer account.');
  });
});

describe('statusImpact edge cases (C23)', () => {
  const status = { code: 'shipped', label: 'Shipped' };
  it('several submissions, no address that gets a notification: the customers, no addresses, no claim that nobody is emailed', () => {
    expect(statusImpact({ notifies_customer: true, status, email_template: 'T', count: 5, recipients: [] }, true)).toBe('Moves to status "Shipped" and emails the customers with the template "T".');
  });
  it('several submissions with fewer than ten addresses lists them as they are; count is not a number of customers', () => {
    const text = statusImpact({ notifies_customer: true, status, email_template: 'T', count: 7, recipients: ['a***@x.example', 'b***@x.example'] }, true);
    expect(text).toBe('Moves to status "Shipped" and emails the customers with the template "T". Masked addresses: a***@x.example, b***@x.example.');
  });
  it('several submissions with notifications but no address shown: the question says the store showed none', () => {
    expect(statusImpact({ notifies_customer: true, status, email_template: null, notifications: [{ id: 2, name: 'Mail' }], count: 3, recipients: [] }, true)).toBe('Moves to status "Shipped" and emails the customers with the notification "Mail". The store shows no address that gets a notification.');
  });
  it('recipient null with no recipients: the customer, unnamed', () => {
    expect(statusImpact({ notifies_customer: true, status, email_template: null, notifications: [{ id: 2, name: 'Mail' }], count: 1, recipient: null })).toBe('Moves to status "Shipped" and emails the customer with the notification "Mail".');
  });
  it('shows at most ten masked addresses and says the list may go on', () => {
    const text = statusImpact({ notifies_customer: true, status, email_template: 'T', count: 30, recipients: Array.from({ length: 15 }, (_, n) => `m${n}***@x.example`) }, true);
    expect(text).toContain('Masked addresses (the store shows at most 10): m0***@x.example');
    expect(text).toContain('m9***@x.example.');
    expect(text).not.toContain('m10***');
    expect(text).not.toMatch(/more|30/);
  });
});

/** Items in ImpactPlanner's format {kind, severity, subject, detail} (DraftContractTest, ImpactPlannerTest, PublishRecipientReviewTest). */
describe('a publish plan as the store sends it', () => {
  const field = { entity: 'field', id: 57, code: 'name', name: 'Name', type: 'text' };
  it('names each field and what its data loses', () => {
    const text = publishPlan([
      { kind: 'field_delete', severity: 'destructive', subject: field, detail: { results: 1, answers: 1, files: 0 } },
      { kind: 'field_type_change', severity: 'destructive', subject: field, detail: { from: 'text', to: 'textarea', results: 4, answers: 4, files: 2 } },
      { kind: 'option_remove', severity: 'destructive', subject: { ...field, name: 'Colour', code: 'colour', type: 'select' }, detail: { removed: ['blue', 'red'], results: 2, answers: 2, files: 0 } },
      { kind: 'logic_change', severity: 'info', subject: { entity: 'form', id: 3 }, detail: { added: 1, removed: 0, changed: 2 } },
      { kind: 'setting_change', severity: 'external', subject: { entity: 'form', id: 3, key: 'redirect_url' }, detail: { from_set: false, to_set: true } },
    ]);
    expect(text).toContain('- destructive: removes the field "Name" (name, text): 1 answer in 1 submission is lost');
    expect(text).toContain('- destructive: changes the type of the field "Name" (name) from text to textarea: 4 answers in 4 submissions, 2 files');
    expect(text).toContain('- destructive: removes the options blue, red of the field "Colour" (colour, select): 2 answers in 2 submissions');
    expect(text).toContain('- info: logic rules: 1 added, 0 removed, 2 changed');
    expect(text).toContain('- external: the setting redirect_url: not set → set');
    expect(text).not.toMatch(/: $/m);
  });

  it('a field without answers says so', () => {
    expect(publishPlan([{ kind: 'field_delete', severity: 'warning', subject: field, detail: { results: 0, answers: 0, files: 0 } }]))
      .toContain('- warning: removes the field "Name" (name, text): no answers or files');
  });

  it('an unknown kind still shows what the store said', () => {
    expect(publishPlan([{ kind: 'future_kind', severity: 'warning', subject: { entity: 'form', id: 3 }, detail: { x: 1 } }]))
      .toContain('- warning future_kind: {"entity":"form","id":3} {"x":1}');
  });
});

describe('an activation diff as the store sends it', () => {
  it('names the submission data the email starts to carry', () => {
    const text = activationDiff({ first_activation: false, recipients: { added: [], removed: [] }, variables: { added: ['field_password', 'customer_ip'], removed: ['old'] } });
    expect(text).toContain('Submission data the email adds: field_password, customer_ip');
    expect(text).toContain('Submission data the email no longer carries: old');
  });
});

describe('the email template of a status change', () => {
  const base = { notifies_customer: true, status: { code: 'done', label: 'Done' }, notifications: [], count: 1, recipient: 'j***@x.example' };
  it('a template the store names by number is not shown as a name', () => {
    expect(statusImpact({ ...base, email_template: '7' })).toContain('with the email template #7');
  });
  it('an empty template is not shown as an empty name', () => {
    expect(statusImpact({ ...base, email_template: '' })).not.toContain('""');
  });
});

describe('a long publish plan', () => {
  it('shows a destructive item even past twelve others, and says how many are left out', () => {
    const info = Array.from({ length: 13 }, () => ({ kind: 'logic_change', severity: 'info', subject: { entity: 'form', id: 3 }, detail: { added: 1, removed: 0, changed: 0 } }));
    const text = publishPlan([...info, { kind: 'field_delete', severity: 'destructive', subject: { entity: 'field', id: 9, code: 'phone', name: 'Phone', type: 'text' }, detail: { results: 2, answers: 2, files: 0 } }]);
    expect(text).toContain('removes the field "Phone"');
    expect(text).toContain('- and 2 more');
  });
});
