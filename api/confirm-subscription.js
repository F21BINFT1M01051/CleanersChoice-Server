const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }
  const { customerId, setupIntentId } = req.body;

  try {
    /* 1. Get the payment-method ID that the SetupIntent saved */
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethod = setupIntent.payment_method;
    if (!paymentMethod) throw new Error("SetupIntent has no payment method");

    /* 2. Attach & set default */
    await stripe.paymentMethods.attach(paymentMethod, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethod },
    });

    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    let subscription;
    let periodEndTimestamp;

    if (existingSubscriptions.data.length > 0) {
      // Update existing subscription instead of creating new one
      subscription = await stripe.subscriptions.update(
        existingSubscriptions.data[0].id,
        {
          items: [{
            id: existingSubscriptions.data[0].items.data[0].id,
            price: process.env.PRICE_ID
          }],
          default_payment_method: paymentMethod,
          proration_behavior: 'none', 
          expand: [
            "latest_invoice.payment_intent",
            "latest_invoice.lines",
          ],
        }
      );
      
      // Get period end from updated subscription
      periodEndTimestamp = subscription.current_period_end * 1000;
      
    } else {
      // Create new subscription for new customers
      subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: process.env.PRICE_ID }],
        default_payment_method: paymentMethod,
        expand: [
          "latest_invoice.payment_intent",
          "latest_invoice.lines",
        ],
      });

      const invoice = subscription.latest_invoice;
      if (!invoice || invoice.status !== "paid") {
        return res.status(400).json({
          success: false,
          message: `Payment failed: ${invoice?.status || "Unknown"}`,
        });
      }

      const firstLine = invoice.lines?.data?.[0];
      periodEndTimestamp = firstLine?.period?.end
        ? firstLine.period.end * 1000
        : null;

      if (!periodEndTimestamp) {
        await new Promise((r) => setTimeout(r, 1000));
        const fullSub = await stripe.subscriptions.retrieve(subscription.id);
        if (fullSub.current_period_end) {
          periodEndTimestamp = fullSub.current_period_end * 1000;
        }
      }
    }

    /* Respond to client */
    return res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      periodEndTimestamp,
      subscriptionStatus: subscription.status,
      updated: existingSubscriptions.data.length > 0, // Optional: indicate if updated vs new
    });
    
  } catch (err) {
    console.error("Subscription Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};




// const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// module.exports = async (req, res) => {
//   if (req.method !== "POST") {
//     res.setHeader("Allow", "POST");
//     return res.status(405).end("Method Not Allowed");
//   }
//   const { customerId, setupIntentId } = req.body;

//   try {
//     /* 1. Get the payment-method ID that the SetupIntent saved */
//     const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
//     const paymentMethod = setupIntent.payment_method;
//     if (!paymentMethod) throw new Error("SetupIntent has no payment method");

//     /* 2. Attach & set default */
//     await stripe.paymentMethods.attach(paymentMethod, { customer: customerId });
//     await stripe.customers.update(customerId, {
//       invoice_settings: { default_payment_method: paymentMethod },
//     });

//     /* 3. Create the subscription — expand invoice + lines */
//     const subscription = await stripe.subscriptions.create({
//       customer: customerId,
//       items: [{ price: process.env.PRICE_ID }],
//       default_payment_method: paymentMethod,
//       expand: [
//         "latest_invoice.payment_intent",
//         "latest_invoice.lines",      // ← gives us period dates
//       ],
//     });

//     const invoice = subscription.latest_invoice;
//     if (!invoice || invoice.status !== "paid") {
//       return res.status(400).json({
//         success: false,
//         message: `Payment failed: ${invoice?.status || "Unknown"}`,
//       });
//     }

//     const firstLine = invoice.lines?.data?.[0];
//     let periodEndTimestamp = firstLine?.period?.end
//       ? firstLine.period.end * 1000
//       : null;

//     if (!periodEndTimestamp) {
//       await new Promise((r) => setTimeout(r, 1000));
//       const fullSub = await stripe.subscriptions.retrieve(subscription.id);
//       if (fullSub.current_period_end) {
//         periodEndTimestamp = fullSub.current_period_end * 1000;
//       }
//     }

//     /* 7. Respond to client */
//     return res.status(200).json({
//       success: true,
//       subscriptionId: subscription.id,
//       periodEndTimestamp,          
//       subscriptionStatus: subscription.status,
//     });
//   } catch (err) {
//     console.error("Subscription Error:", err);
//     return res.status(500).json({ success: false, message: err.message });
//   }
// };
