// overlay.cpp — ChatCommander Overlay
// Transparent fullscreen always-on-top window
// Compile: g++ overlay.cpp -o overlay.exe -lgdi32 -lgdiplus -luser32 -mwindows

#define UNICODE
#define _UNICODE
#include <windows.h>
#include <windowsx.h>
#include <gdiplus.h>
#include <string>
#include <thread>
#include <mutex>
#include <sstream>
#include <iostream>
#include <algorithm>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

using namespace Gdiplus;

HWND g_hwnd = NULL;
Image* g_image = nullptr;
std::mutex g_imageMutex;

int g_srcX = 200, g_srcY = 200;
int g_srcW = 300, g_srcH = 300;

bool g_dragging = false;
bool g_resizing = false;
int g_dragOffX = 0, g_dragOffY = 0;

int g_screenW = 0, g_screenH = 0;
const int CORNER = 20;

// ---- Is point inside source? ------------------------------------------------
int hitTest(int mx, int my) {
    int rx = g_srcX + g_srcW - CORNER;
    int ry = g_srcY + g_srcH - CORNER;
    if (mx >= rx && mx <= g_srcX + g_srcW && my >= ry && my <= g_srcY + g_srcH)
        return 1; // resize corner
    if (mx >= g_srcX && mx <= g_srcX + g_srcW && my >= g_srcY && my <= g_srcY + g_srcH)
        return 2; // body
    return 0;
}

// ---- Set window click-through or not ----------------------------------------
void setClickThrough(bool through) {
    LONG ex = GetWindowLong(g_hwnd, GWL_EXSTYLE);
    if (through) ex |= WS_EX_TRANSPARENT;
    else         ex &= ~WS_EX_TRANSPARENT;
    SetWindowLong(g_hwnd, GWL_EXSTYLE, ex);
}

// ---- Paint ------------------------------------------------------------------
void paintOverlay() {
    if (!g_hwnd) return;

    HDC hdcScreen = GetDC(NULL);
    HDC hdcMem    = CreateCompatibleDC(hdcScreen);

    // Use DIB with alpha channel for proper transparency
    BITMAPINFOHEADER bi = {};
    bi.biSize        = sizeof(bi);
    bi.biWidth       = g_screenW;
    bi.biHeight      = -g_screenH; // top-down
    bi.biPlanes      = 1;
    bi.biBitCount    = 32;
    bi.biCompression = BI_RGB;

    void* pvBits = nullptr;
    HBITMAP hbm = CreateDIBSection(hdcScreen, (BITMAPINFO*)&bi, DIB_RGB_COLORS, &pvBits, NULL, 0);
    HBITMAP hOld = (HBITMAP)SelectObject(hdcMem, hbm);

    // Clear to fully transparent
    memset(pvBits, 0, g_screenW * g_screenH * 4);

    {
        Graphics gfx(hdcMem);
        gfx.SetCompositingMode(CompositingModeSourceOver);
        gfx.SetSmoothingMode(SmoothingModeAntiAlias);

        std::lock_guard<std::mutex> lock(g_imageMutex);
        if (g_image && g_image->GetLastStatus() == Ok) {
            gfx.DrawImage(g_image, g_srcX, g_srcY, g_srcW, g_srcH);

            // Resize handle
            SolidBrush hBrush(Color(200, 255, 255, 255));
            gfx.FillRectangle(&hBrush, g_srcX + g_srcW - CORNER, g_srcY + g_srcH - CORNER, CORNER, CORNER);

            // Border
            Pen border(Color(160, 255, 255, 255), 1.5f);
            gfx.DrawRectangle(&border, g_srcX, g_srcY, g_srcW - 1, g_srcH - 1);
        }
    }

    BLENDFUNCTION bf = { AC_SRC_OVER, 0, 255, AC_SRC_ALPHA };
    POINT ptSrc = { 0, 0 };
    POINT ptDst = { 0, 0 };
    SIZE  sz    = { g_screenW, g_screenH };
    UpdateLayeredWindow(g_hwnd, hdcScreen, &ptDst, &sz, hdcMem, &ptSrc, 0, &bf, ULW_ALPHA);

    SelectObject(hdcMem, hOld);
    DeleteObject(hbm);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
}

// ---- Load image -------------------------------------------------------------
void loadImage(const std::wstring& path) {
    std::lock_guard<std::mutex> lock(g_imageMutex);
    if (g_image) { delete g_image; g_image = nullptr; }
    g_image = new Image(path.c_str());
    if (g_image->GetLastStatus() != Ok) {
        delete g_image; g_image = nullptr;
    } else {
        UINT iw = g_image->GetWidth();
        UINT ih = g_image->GetHeight();
        g_srcW = std::min((UINT)400, iw);
        g_srcH = (int)((float)g_srcW / iw * ih);
    }
}

// ---- WndProc ----------------------------------------------------------------
LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {

    case WM_MOUSEMOVE: {
        int mx = GET_X_LPARAM(lp);
        int my = GET_Y_LPARAM(lp);
        if (g_resizing) {
            g_srcW = std::max(50, mx - g_srcX);
            std::lock_guard<std::mutex> lock(g_imageMutex);
            if (g_image && g_image->GetLastStatus() == Ok) {
                float asp = (float)g_image->GetWidth() / g_image->GetHeight();
                g_srcH = (int)(g_srcW / asp);
            } else {
                g_srcH = std::max(50, my - g_srcY);
            }
            paintOverlay();
        } else if (g_dragging) {
            g_srcX = mx - g_dragOffX;
            g_srcY = my - g_dragOffY;
            paintOverlay();
        } else {
            int hit = hitTest(mx, my);
            if (hit == 1) SetCursor(LoadCursor(NULL, IDC_SIZENWSE));
            else if (hit == 2) SetCursor(LoadCursor(NULL, IDC_SIZEALL));
            else SetCursor(LoadCursor(NULL, IDC_ARROW));
        }
        return 0;
    }

    case WM_LBUTTONDOWN: {
        int mx = GET_X_LPARAM(lp);
        int my = GET_Y_LPARAM(lp);
        int hit = hitTest(mx, my);
        if (hit == 1) {
            g_resizing = true;
            SetCapture(hwnd);
        } else if (hit == 2) {
            g_dragging = true;
            g_dragOffX = mx - g_srcX;
            g_dragOffY = my - g_srcY;
            SetCapture(hwnd);
        }
        return 0;
    }

    case WM_LBUTTONUP:
        g_dragging = false;
        g_resizing = false;
        ReleaseCapture();
        return 0;

    case WM_RBUTTONDOWN: {
        int mx = GET_X_LPARAM(lp);
        int my = GET_Y_LPARAM(lp);
        if (hitTest(mx, my)) {
            std::lock_guard<std::mutex> lock(g_imageMutex);
            if (g_image) { delete g_image; g_image = nullptr; }
            paintOverlay();
            setClickThrough(true); // nothing on screen, pass clicks through
        }
        return 0;
    }

    case WM_TIMER: {
        if (wp == 1) {
            POINT pt;
            GetCursorPos(&pt);
            bool overSource = hitTest(pt.x, pt.y) != 0;
            setClickThrough(!overSource && !g_dragging && !g_resizing);
        }
        return 0;
    }

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

// ---- Stdin thread -----------------------------------------------------------
void stdinThread() {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        std::istringstream ss(line);
        std::string cmd;
        ss >> cmd;
        if (cmd == "QUIT") {
            PostMessage(g_hwnd, WM_DESTROY, 0, 0);
            break;
        } else if (cmd == "LOAD") {
            std::string rest;
            std::getline(ss, rest);
            if (!rest.empty() && rest[0] == ' ') rest = rest.substr(1);
            std::wstring wpath(rest.begin(), rest.end());
            loadImage(wpath);
            PostMessage(g_hwnd, WM_USER + 1, 0, 0); // trigger repaint on main thread
        } else if (cmd == "MOVE") {
            int x, y; ss >> x >> y;
            g_srcX = x; g_srcY = y;
            PostMessage(g_hwnd, WM_USER + 1, 0, 0);
        } else if (cmd == "SIZE") {
            int w, h; ss >> w >> h;
            g_srcW = w; g_srcH = h;
            PostMessage(g_hwnd, WM_USER + 1, 0, 0);
        }
    }
}

// ---- WinMain ----------------------------------------------------------------
int WINAPI WinMain(HINSTANCE hInst, HINSTANCE, LPSTR lpCmd, int) {
    GdiplusStartupInput gdipInput;
    ULONG_PTR gdipToken;
    GdiplusStartup(&gdipToken, &gdipInput, NULL);

    g_screenW = GetSystemMetrics(SM_CXSCREEN);
    g_screenH = GetSystemMetrics(SM_CYSCREEN);

    WNDCLASSEX wc = {};
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = WndProc;
    wc.hInstance     = hInst;
    wc.lpszClassName = L"CCOverlay";
    wc.hCursor       = LoadCursor(NULL, IDC_ARROW);
    RegisterClassEx(&wc);

    // Layered + topmost + no taskbar entry
    // Start as click-through (WS_EX_TRANSPARENT), only disable when over a source
    g_hwnd = CreateWindowEx(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        L"CCOverlay", L"ChatCommander Overlay",
        WS_POPUP,
        0, 0, g_screenW, g_screenH,
        NULL, NULL, hInst, NULL
    );

    ShowWindow(g_hwnd, SW_SHOW);
    SetTimer(g_hwnd, 1, 16, NULL); // ~60fps mouse check

    // Load image from command line if provided
    if (lpCmd && strlen(lpCmd) > 0) {
        std::string p(lpCmd);
        if (!p.empty() && p[0] == '"') p = p.substr(1);
        if (!p.empty() && p.back() == '"') p.pop_back();
        std::wstring wp(p.begin(), p.end());
        loadImage(wp);
    }

    paintOverlay();

    std::thread t(stdinThread);
    t.detach();

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        if (msg.message == WM_USER + 1) {
            paintOverlay();
            continue;
        }
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    { std::lock_guard<std::mutex> lock(g_imageMutex); if (g_image) delete g_image; }
    GdiplusShutdown(gdipToken);
    return 0;
}