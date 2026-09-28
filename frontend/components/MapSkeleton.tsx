/**
 * Скелетон загрузки карты: три пульсирующих гексагона (дизайн-спека §4.8).
 *
 * Показывается вместо текстовой карточки: честно говорит, что грузится именно тепловой слой,
 * и не блокирует карту — пользователь видит подложку и понимает, что происходит.
 */
export default function MapSkeleton() {
  return (
    <div
      className="skeleton"
      role="status"
      aria-label="Загружаем тепловую карту"
      data-testid="map-skeleton"
    >
      <span className="skeleton__hex" aria-hidden="true" />
      <span className="skeleton__hex skeleton__hex--mid" aria-hidden="true" />
      <span className="skeleton__hex skeleton__hex--low" aria-hidden="true" />
      <span className="skeleton__text">Загружаем тепловую карту…</span>
    </div>
  );
}
