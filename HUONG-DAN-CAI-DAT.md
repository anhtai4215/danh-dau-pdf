# Đánh dấu PDF v2 – Hướng dẫn cài đặt và sử dụng

App dạng PWA: cài từ trình duyệt lên màn hình chính, chạy như app thường, dùng được khi không có mạng.
Toàn bộ bản vẽ, ghi chú và ảnh **lưu ngay trong điện thoại**, không gửi lên máy chủ nào.

## Cài đặt / cập nhật

1. Upload **toàn bộ nội dung** thư mục `danh-dau-pdf` lên repo GitHub (đè file cũ):
   index.html, app.js, style.css, sw.js, manifest.webmanifest và các thư mục `lib`, `icons`, `fonts`.
2. Lần đầu: vào **Settings → Pages** → Branch `main`, thư mục `/ (root)` → **Save**.
3. Mở địa chỉ `https://<tài-khoản>.github.io/<tên-repo>/` trên điện thoại:
   - **Android (Chrome):** bấm **Cài đặt** hoặc menu ⋮ → **Cài đặt ứng dụng**.
   - **iPhone (Safari):** **Chia sẻ** → **Thêm vào MH chính**.
4. Khi cập nhật: upload đè file và **tăng `VERSION` trong `sw.js`**. Đóng hẳn app rồi mở lại để nhận bản mới.
   Dữ liệu bản 1.x **tự chuyển** sang cấu trúc mới: mỗi bản vẽ cũ thành một dự án, các điểm cũ thành loại *Vướng mắc*.

## Cấu trúc: Dự án → Bản vẽ → Điểm ghi nhận

- **Dự án** khai báo một lần: tên, mã dự án, chủ đầu tư, địa điểm, kính gửi mặc định, đơn vị lập (tên công ty, logo,
  người lập), các bên ký xác nhận, tiền tố và số báo cáo tiếp theo (tự tăng).
- Mỗi dự án có nhiều **bản vẽ PDF** (chọn nhiều file một lúc).
- **Đánh số liên tục theo loại trong toàn dự án**: VM-01, VM-02, PS-01…

## 8 loại ghi nhận – ký hiệu theo loại, màu theo trạng thái

| Loại | Mã | Ký hiệu | Trạng thái |
|---|---|---|---|
| Vướng mắc | VM | Tròn | Mới ghi nhận → Đã gửi → Đã phản hồi → Đã đóng |
| Phát sinh | PS | Thoi | Ghi nhận → Đã trình → Đã duyệt / Từ chối |
| Thay đổi thiết kế | TĐ | Tam giác | Cần xử lý → Đang xử lý → Đã xong |
| Lỗi / khiếm khuyết | KK | Vuông | như trên |
| An toàn | AT | Bát giác | như trên |
| Nghiệm thu | NT | Tròn kép | như trên |
| Hiện trạng | HT | Lục giác | như trên |
| Ghi chú | GC | Vuông bo góc | như trên |

Màu: đỏ = mới / cần xử lý · cam = đang xử lý / đã gửi / đã trình · xanh dương = đã phản hồi · xanh lá = xong / đã duyệt / đã đóng · xám = từ chối.

Trường riêng theo loại: Vướng mắc (đề xuất xử lý, phản hồi của các bên), Phát sinh (căn cứ / lý do),
Thay đổi (căn cứ văn bản, chỉ thị), Lỗi (yêu cầu khắc phục), An toàn (biện pháp khắc phục).

## Kiểu đánh dấu

Bấm **Đánh dấu** → chọn **loại** và **kiểu**:
- **Điểm**: chạm vào vị trí.
- **Vùng / Vùng mây**: kéo 1 ngón để khoanh vùng (2 ngón vẫn để zoom).
- **Mũi tên**: kéo từ chỗ đặt ký hiệu đến vị trí cần chỉ.

Trong thẻ chi tiết: đổi loại (mã tự cấp lại), đổi trạng thái, *Di chuyển* (điểm) hoặc *Vẽ lại* (vùng, mũi tên).

## Bộ lọc

Nút phễu ở thanh dưới hoặc trong Danh sách: lọc theo **loại** (chọn nhiều), **trạng thái** (chưa xong / đã xong),
**phụ trách**, **quá hạn**. Áp dụng cho ký hiệu trên bản vẽ, danh sách và nút xuất nhanh bản vẽ.

## Báo cáo PDF gửi các bên

Trang dự án → **Lập báo cáo** (hoặc từ menu bản vẽ / Danh sách):
- Chọn **loại**, **trạng thái**, **bản vẽ**. Tiêu đề tự đổi theo loại (VD chỉ chọn Phát sinh → "Báo cáo ghi nhận phát sinh").
- Số báo cáo lấy tự động từ dự án và **tự tăng** sau mỗi lần lập.
- Nội dung: trang bìa (logo, đơn vị lập, thông tin dự án, kính gửi, thống kê theo loại), tóm tắt / kiến nghị,
  bảng tổng hợp nhóm theo loại, ô ký xác nhận các bên,
  **Phụ lục 1** bản vẽ gốc có ký hiệu vector và chú giải, **Phụ lục 2** chi tiết từng điểm kèm ảnh trích vị trí và ảnh hiện trường.
- Chữ tiếng Việt thật (tìm kiếm, copy được), đánh số trang, chia sẻ thẳng qua Zalo / Email.

## Sao lưu

Menu dự án → **Sao lưu dự án (.pmk)**: gồm toàn bộ bản vẽ, điểm và ảnh. Mở app trên máy khác → **Khôi phục**.
Gỡ app hoặc xóa dữ liệu trình duyệt sẽ mất dữ liệu, nên sao lưu định kỳ. Đọc được cả file .pmk của bản cũ.
