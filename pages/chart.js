import { useContext } from "react";
import { CartContext } from "./_app";
import { Trash2 } from "lucide-react";

export default function CartPage() {
  const { cart, updateQty, removeFromCart } = useContext(CartContext);
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Your Cart</h1>
      {cart.length === 0 ? (
        <p className="text-gray-500">Your cart is empty.</p>
      ) : (
        <div className="space-y-4">
          {cart.map((item) => (
            <div key={item.id} className="flex items-center justify-between bg-white p-4 rounded-xl shadow">
              <div>
                <h3 className="text-lg font-semibold">{item.name}</h3>
                <p className="text-blue-700 font-bold">${item.price.toFixed(2)}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  value={item.qty}
                  onChange={(e) => updateQty(item.id, parseInt(e.target.value))}
                  className="w-16 border rounded p-2"
                />
                <button onClick={() => removeFromCart(item.id)} className="bg-red-600 text-white p-2 rounded">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
          <div className="flex justify-between items-center border-t pt-4">
            <h2 className="text-xl font-bold">Subtotal</h2>
            <span className="text-xl font-bold text-blue-700">${subtotal.toFixed(2)}</span>
          </div>
          <a href="/checkout" className="block w-full text-center bg-green-600 text-white py-3 rounded-xl text-lg mt-4">
            Proceed to Checkout
          </a>
        </div>
      )}
    </div>
  );
}
