import { useState, useContext } from "react";
import { CartContext } from "./_app";

export default function CheckoutPage() {
  const { cart } = useContext(CartContext);
  const [form, setForm] = useState({ name: "", address: "", city: "", zip: "" });
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleCheckout = () => {
    alert("✅ Order placed! (Integrate Stripe/PayPal here)");
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Checkout</h1>
      <div className="space-y-4">
        <input name="name" placeholder="Full Name" className="w-full border p-3 rounded-xl" onChange={handleChange} />
        <input name="address" placeholder="Street Address" className="w-full border p-3 rounded-xl" onChange={handleChange} />
        <div className="grid grid-cols-2 gap-4">
          <input name="city" placeholder="City" className="w-full border p-3 rounded-xl" onChange={handleChange} />
          <input name="zip" placeholder="ZIP Code" className="w-full border p-3 rounded-xl" onChange={handleChange} />
        </div>
      </div>
      <div className="mt-6 flex justify-between text-xl font-bold">
        <span>Total</span>
        <span className="text-blue-700">${subtotal.toFixed(2)}</span>
      </div>
      <button onClick={handleCheckout} className="w-full mt-6 bg-green-600 text-white py-3 rounded-xl text-lg">
        Pay Now
      </button>
    </div>
  );
}
