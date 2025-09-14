async function fetchProducts(q='') {
  const res = await fetch('/api/products');
  const products = await res.json();
  const container = document.getElementById('products');
  container.innerHTML = '';
  const filter = q.toLowerCase();
  products.filter(p => p.title.toLowerCase().includes(filter) || p.category.toLowerCase().includes(filter))
    .forEach(p => {
      const el = document.createElement('div');
      el.className = 'product';
      el.innerHTML = `<h3>${p.title}</h3><p>${p.description}</p><strong>$${p.price.toFixed(2)}</strong><button data-id="${p.id}">Add</button>`;
      container.appendChild(el);
    });
  document.querySelectorAll('.product button').forEach(b => b.addEventListener('click', e => {
    addToCart(e.target.dataset.id);
  }));
}
const CART_KEY = 'oap_cart';
function getCart(){ return JSON.parse(localStorage.getItem(CART_KEY)||'[]'); }
function saveCart(c){ localStorage.setItem(CART_KEY, JSON.stringify(c)); updateCartCount(); }
function addToCart(id){
  const c = getCart();
  c.push({id, qty:1});
  saveCart(c);
  alert('Added to cart');
}
function updateCartCount(){ document.getElementById('cart-count').innerText = getCart().length; }
document.getElementById('search').addEventListener('input', e=> fetchProducts(e.target.value));
document.getElementById('view-cart').addEventListener('click', async ()=>{
  const cart = getCart();
  if (!cart.length){ alert('Cart is empty'); return; }
  // build order
  const productRes = await fetch('/api/products');
  const products = await productRes.json();
  const items = cart.map(ci => {
    const p = products.find(x=>x.id===ci.id);
    return { id: p.id, title: p.title, price: p.price, qty: ci.qty };
  });
  const customer = { name: prompt('Your name'), email: prompt('Your email') };
  const res = await fetch('/api/orders', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ items, customer })
  });
  const j = await res.json();
  if (j.success){ localStorage.removeItem(CART_KEY); updateCartCount(); alert('Order placed! ID: '+j.orderId); }
});
// init
fetchProducts();
updateCartCount();
