import React from 'react';

export function Elements({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function PaymentElement() {
  return <div data-sway-stripe-payment-element-stub="true">Secure payment fields</div>;
}

export function useElements() {
  return {};
}

export function useStripe() {
  return {
    confirmPayment: async () => new Promise((resolve) => {
      (window as any).__swayStripeAuthorizationStarted = true;
      (window as any).__swayResolveStripeAuthorization = () => resolve({
        paymentIntent: { id: 'pi_fixture_authorized', status: 'requires_capture' }
      });
    })
  };
}
