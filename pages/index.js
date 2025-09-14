import { useState, useEffect, useContext } from "react";
import { CartContext } from "./_app";
import { ShoppingCart } from "lucide-react";

const sampleParts = [
  { id: 1, name: "Brake Pads – Front", image: "https://via.placeholder.com/250x150.png?text=Brake+Pads", price: 129.99, year: 2020, make: "Toyota", model: "Camry" },
  { id: 2, name: "Alternator", image: "https://via.placeholder.com/250x150.png?text=Alternator", price: 249.99, year: 2019, make: "Honda", model: "Civic" },
  { id: 3, name: "Radiator", image: "https://via.placeholder.com/250x150.png?text=Radiator", price: 199.99, year: 2021, make: "Ford", model: "F-150" },
];

export default function HomePage() {
  const { addToCart } = useContext(CartContext);
  const [filters, setFilters] = useState({ year: "", make: "", model: "", search: "" });
  const [parts, setParts] = useState([]);

  useEffect(() => {
    // Replace with fetch("/api/parts")
    setParts(sampleParts);
  }, []);

  const filteredParts = parts.filter((part) => {
    return (
      (!filters.year || part.year.toString() === filters.year) &&
      (!filters.make || part.make === filters.make) &&
      (!filters.model || part.model === filters.model) &&
      (!filters.search || part.name.toLowerCase().includes(filters.search.toLowerCase()))
    );
  });

  const years = [...new Set(parts.map((p) => p.year))];
  const makes = [...new Set(parts.map((p) => p.make))];
  const models = [...new Set(parts.map((p) => p.model))];

  return (
    <div className="min-h-screen bg-gray-50">
      <section className="bg-blue-900 text-white text-center py-12">
        <h1 className="text-4xl font-bold">Ohio Auto Parts</h1>
        <p className="mt-2 text-lg">Affordable, reliable parts with a $50 markup included.</p>
      </section>

      {/* Filters */}
      <section className="max-w-6xl mx-auto p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        <select className="border p-3 rounded-xl" onChange={(e) => setFilters({ ...filters, year: e.target.value })}>
          <option value="">Year</option>
          {years.map((year) => <option key={year}>{year}</option>)}
        </select>
        <select className="border p-3 rounded-xl" onChange={(e) => setFilters({ ...filters, make: e.target.value })}>
          <option value="">Make</option>
          {makes.map((make) => <option key={make}>{make}</option>)}
        </select>
        <select className="border p-3 rounded-xl" onChange={(e) => setFilters({ ...filters, model: e.target.value })}>
          <option value="">Model</option>
          {models.map((model) => <option key={model}>{model}</option>)}
        </select>
        <input
          type="text"
          placeholder="Search part..."
          className="border p-3 rounded-xl"
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
      </section>

      {/* Parts */}
      <section className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 p-4">
        {filteredParts.map((part) => (
          <div key={part.id} className="rounded-2xl shadow bg-white hover:shadow-lg transition">
            <img src={part.image} alt={part.name} className="w-full h-40 object-cover rounded-t-2xl" />
            <div className="p-4">
              <h3 className="text-lg font-semibold">{part.name}</h3>
              <p className="text-sm text-gray-500">{part.year} {part.make} {part.model}</p>
              <p className="text-blue-700 font-bold mt-2">${part.price.toFixed(2)}</p>
              <button
                className="mt-4 w-full flex items-center justify-center gap-2 bg-blue-600 text-white py-2 rounded-xl"
                onClick={() => addToCart(part)}
              >
                <ShoppingCart size={18} /> Add to Cart
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
