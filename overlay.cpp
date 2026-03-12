// overlay.cpp — ChatCommander Overlay (multi-source)
// Compile: g++ overlay.cpp -o overlay.exe -lgdi32 -lgdiplus -luser32 -lwinmm -mwindows

#define UNICODE
#define _UNICODE
#include <windows.h>
#include <windowsx.h>
#include <gdiplus.h>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <sstream>
#include <fstream>
#include <algorithm>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "winmm.lib")

using namespace Gdiplus;

struct Source {
    int id;
    std::wstring path;
    Image* image;
    int x, y, w, h;
    bool hidden;
    Source(int id_, std::wstring p, Image* img, int x_, int y_, int w_, int h_)
        : id(id_), path(p), image(img), x(x_), y(y_), w(w_), h(h_), hidden(false) {}
};

std::vector<Source> g_sources;
std::mutex g_mutex;
HWND g_hwnd = NULL;
int g_screenW = 0, g_screenH = 0;
std::string g_cmdPath;
std::string g_posPath;

const int CORNER = 20;
int g_dragId = -1;
bool g_dragging = false, g_resizing = false;
int g_dragOffX = 0, g_dragOffY = 0;

Source* findSrc(int id) {
    for (auto& s : g_sources) if (s.id == id) return &s;
    return nullptr;
}

int hitTest(int mx, int my, bool& corner) {
    std::lock_guard<std::mutex> lk(g_mutex);
    for (int i = (int)g_sources.size()-1; i >= 0; i--) {
        auto& s = g_sources[i];
        if (s.hidden) continue;
        int rx = s.x + s.w - CORNER, ry = s.y + s.h - CORNER;
        if (mx >= rx && mx <= s.x+s.w && my >= ry && my <= s.y+s.h) { corner=true; return s.id; }
        if (mx >= s.x && mx <= s.x+s.w && my >= s.y && my <= s.y+s.h) { corner=false; return s.id; }
    }
    corner=false; return -1;
}

// caller must NOT hold g_mutex
void savePositions() {
    if (g_posPath.empty()) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    std::ofstream f(g_posPath);
    if (!f.is_open()) return;
    f << "[";
    bool first = true;
    for (auto& s : g_sources) {
        if (!first) f << ",";
        f << "{\"id\":" << s.id << ",\"x\":" << s.x << ",\"y\":" << s.y
          << ",\"w\":" << s.w << ",\"h\":" << s.h << "}";
        first = false;
    }
    f << "]";
}

// caller must hold g_mutex
void savePositionsLocked() {
    if (g_posPath.empty()) return;
    std::ofstream f(g_posPath);
    if (!f.is_open()) return;
    f << "[";
    bool first = true;
    for (auto& s : g_sources) {
        if (!first) f << ",";
        f << "{\"id\":" << s.id << ",\"x\":" << s.x << ",\"y\":" << s.y
          << ",\"w\":" << s.w << ",\"h\":" << s.h << "}";
        first = false;
    }
    f << "]";
}

void setClickThrough(bool t) {
    LONG ex = GetWindowLong(g_hwnd, GWL_EXSTYLE);
    if (t) ex |= WS_EX_TRANSPARENT; else ex &= ~WS_EX_TRANSPARENT;
    SetWindowLong(g_hwnd, GWL_EXSTYLE, ex);
}

void paint() {
    if (!g_hwnd) return;
    HDC hdcScreen = GetDC(NULL);
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    BITMAPINFOHEADER bi = {};
    bi.biSize=sizeof(bi); bi.biWidth=g_screenW; bi.biHeight=-g_screenH;
    bi.biPlanes=1; bi.biBitCount=32; bi.biCompression=BI_RGB;
    void* pvBits=nullptr;
    HBITMAP hbm = CreateDIBSection(hdcScreen,(BITMAPINFO*)&bi,DIB_RGB_COLORS,&pvBits,NULL,0);
    HBITMAP hOld = (HBITMAP)SelectObject(hdcMem,hbm);
    memset(pvBits,0,g_screenW*g_screenH*4);
    {
        Graphics gfx(hdcMem);
        gfx.SetCompositingMode(CompositingModeSourceOver);
        std::lock_guard<std::mutex> lk(g_mutex);
        for (auto& s : g_sources) {
            if (s.hidden || !s.image || s.image->GetLastStatus()!=Ok) continue;
            gfx.DrawImage(s.image, s.x, s.y, s.w, s.h);
            Pen border(Color(140,255,255,255),1.5f);
            gfx.DrawRectangle(&border, s.x, s.y, s.w-1, s.h-1);
            SolidBrush cornerBrush(Color(200,255,255,255));
            gfx.FillRectangle(&cornerBrush, s.x+s.w-CORNER, s.y+s.h-CORNER, CORNER, CORNER);
        }
    }
    BLENDFUNCTION bf={AC_SRC_OVER,0,255,AC_SRC_ALPHA};
    POINT ps={0,0},pd={0,0}; SIZE sz={g_screenW,g_screenH};
    UpdateLayeredWindow(g_hwnd,hdcScreen,&pd,&sz,hdcMem,&ps,0,&bf,ULW_ALPHA);
    SelectObject(hdcMem,hOld); DeleteObject(hbm); DeleteDC(hdcMem); ReleaseDC(NULL,hdcScreen);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch(msg) {
    case WM_TIMER: {
        POINT pt; GetCursorPos(&pt);
        bool corner;
        bool over = hitTest(pt.x,pt.y,corner) >= 0;
        setClickThrough(!over && !g_dragging && !g_resizing);
        return 0;
    }
    case WM_MOUSEMOVE: {
        int mx=GET_X_LPARAM(lp), my=GET_Y_LPARAM(lp);
        if (g_resizing) {
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                Source* s = findSrc(g_dragId);
                if (s) {
                    s->w = std::max(50, mx-s->x);
                    if (s->image && s->image->GetLastStatus()==Ok) {
                        float asp=(float)s->image->GetWidth()/s->image->GetHeight();
                        s->h=(int)(s->w/asp);
                    } else s->h=std::max(50,my-s->y);
                }
            }
            paint();
        } else if (g_dragging) {
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                Source* s = findSrc(g_dragId);
                if (s) { s->x=mx-g_dragOffX; s->y=my-g_dragOffY; }
            }
            paint();
        } else {
            bool corner;
            int hit=hitTest(mx,my,corner);
            if (corner) SetCursor(LoadCursor(NULL,IDC_SIZENWSE));
            else if (hit>=0) SetCursor(LoadCursor(NULL,IDC_SIZEALL));
            else SetCursor(LoadCursor(NULL,IDC_ARROW));
        }
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int mx=GET_X_LPARAM(lp), my=GET_Y_LPARAM(lp);
        bool corner; int hit=hitTest(mx,my,corner);
        if (hit>=0) {
            g_dragId=hit;
            if (corner) { g_resizing=true; }
            else {
                g_dragging=true;
                std::lock_guard<std::mutex> lk(g_mutex);
                Source* s=findSrc(hit);
                if (s) { g_dragOffX=mx-s->x; g_dragOffY=my-s->y; }
            }
            SetCapture(hwnd);
        }
        return 0;
    }
    case WM_LBUTTONUP:
        if (g_dragging||g_resizing) savePositions();
        g_dragging=false; g_resizing=false; g_dragId=-1;
        ReleaseCapture(); return 0;
    case WM_RBUTTONDOWN: {
        int mx=GET_X_LPARAM(lp), my=GET_Y_LPARAM(lp);
        bool corner; int hit=hitTest(mx,my,corner);
        if (hit>=0) {
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                for (auto it=g_sources.begin();it!=g_sources.end();++it) {
                    if (it->id==hit) { delete it->image; g_sources.erase(it); break; }
                }
                savePositionsLocked();
            }
            paint();
        }
        return 0;
    }
    case WM_USER+1: paint(); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProc(hwnd,msg,wp,lp);
}

Image* loadImg(const std::wstring& path) {
    Image* img = new Image(path.c_str());
    if (img->GetLastStatus()!=Ok) { delete img; return nullptr; }
    return img;
}

void pollThread() {
    while (true) {
        Sleep(100);
        if (g_cmdPath.empty()) continue;
        std::ifstream f(g_cmdPath);
        if (!f.is_open()) continue;
        std::string line;
        if (!std::getline(f,line)) { f.close(); continue; }
        f.close();
        if (line.empty()) continue;
        std::ofstream clr(g_cmdPath,std::ofstream::trunc); clr.close();

        std::istringstream ss(line);
        std::string cmd; ss>>cmd;

        if (cmd=="QUIT") {
            PostMessage(g_hwnd,WM_DESTROY,0,0); break;
        }
        else if (cmd=="LOAD") {
            int id; ss>>id;
            std::string rest; std::getline(ss,rest);
            if (!rest.empty()&&rest[0]==' ') rest=rest.substr(1);
            std::wstring wpath(rest.begin(),rest.end());
            Image* img=loadImg(wpath); // load OUTSIDE mutex
            if (!img) continue;
            int x=200,y=200,w=300,h=300;
            // read saved pos outside mutex
            if (!g_posPath.empty()) {
                std::ifstream pf(g_posPath);
                std::string pline; std::getline(pf,pline);
                std::string tok="\"id\":"+std::to_string(id);
                size_t pos=pline.find(tok);
                if (pos!=std::string::npos) {
                    auto getVal=[&](const std::string& key)->int{
                        std::string k="\""+key+"\":";
                        size_t p2=pline.find(k,pos);
                        if(p2==std::string::npos) return 0;
                        return std::stoi(pline.substr(p2+k.size()));
                    };
                    x=getVal("x"); y=getVal("y"); w=getVal("w"); h=getVal("h");
                } else {
                    UINT iw=img->GetWidth(),ih=img->GetHeight();
                    w=(int)std::min((UINT)400,iw); h=(int)((float)w/iw*ih);
                }
            } else {
                UINT iw=img->GetWidth(),ih=img->GetHeight();
                w=(int)std::min((UINT)400,iw); h=(int)((float)w/iw*ih);
            }
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                for (auto it=g_sources.begin();it!=g_sources.end();++it) {
                    if (it->id==id) { delete it->image; g_sources.erase(it); break; }
                }
                g_sources.emplace_back(id,wpath,img,x,y,w,h);
            } // mutex released HERE before PostMessage
            PostMessage(g_hwnd,WM_USER+1,0,0);
        }
        else if (cmd=="REMOVE") {
            int id; ss>>id;
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                for (auto it=g_sources.begin();it!=g_sources.end();++it) {
                    if (it->id==id) { delete it->image; g_sources.erase(it); break; }
                }
                savePositionsLocked();
            } // mutex released HERE
            PostMessage(g_hwnd,WM_USER+1,0,0);
        }
        else if (cmd=="CLEAR") {
            int id; ss>>id;
            {
                std::lock_guard<std::mutex> lk(g_mutex);
                Source* s=findSrc(id);
                if (s) s->hidden=true;
            } // mutex released HERE
            PostMessage(g_hwnd,WM_USER+1,0,0);
        }
        else if (cmd=="MOVE") {
            int id,x,y; ss>>id>>x>>y;
            { std::lock_guard<std::mutex> lk(g_mutex); Source* s=findSrc(id); if(s){s->x=x;s->y=y;} }
            PostMessage(g_hwnd,WM_USER+1,0,0);
        }
        else if (cmd=="SIZE") {
            int id,w,h; ss>>id>>w>>h;
            { std::lock_guard<std::mutex> lk(g_mutex); Source* s=findSrc(id); if(s){s->w=w;s->h=h;} }
            PostMessage(g_hwnd,WM_USER+1,0,0);
        }
        else if (cmd=="SOUND") {
            std::string rest; std::getline(ss,rest);
            if (!rest.empty()&&rest[0]==' ') rest=rest.substr(1);
            std::wstring wpath(rest.begin(),rest.end());
            PlaySoundW(wpath.c_str(),NULL,SND_FILENAME|SND_ASYNC);
        }
    }
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE, LPSTR lpCmd, int) {
    GdiplusStartupInput gi; ULONG_PTR gt;
    GdiplusStartup(&gt,&gi,NULL);

    if (lpCmd&&strlen(lpCmd)>0) {
        std::string args(lpCmd);
        std::vector<std::string> parts;
        std::string cur; bool inq=false;
        for (char c:args) {
            if (c=='"') inq=!inq;
            else if (c==' '&&!inq) { if(!cur.empty()){parts.push_back(cur);cur="";} }
            else cur+=c;
        }
        if (!cur.empty()) parts.push_back(cur);
        if (parts.size()>=1) g_cmdPath=parts[0];
        if (parts.size()>=2) g_posPath=parts[1];
    }

    g_screenW=GetSystemMetrics(SM_CXSCREEN);
    g_screenH=GetSystemMetrics(SM_CYSCREEN);

    WNDCLASSEX wc={}; wc.cbSize=sizeof(wc); wc.lpfnWndProc=WndProc;
    wc.hInstance=hInst; wc.lpszClassName=L"CCOverlay";
    wc.hCursor=LoadCursor(NULL,IDC_ARROW);
    RegisterClassEx(&wc);

    g_hwnd=CreateWindowEx(
        WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,
        L"CCOverlay",L"ChatCommander Overlay",
        WS_POPUP,0,0,g_screenW,g_screenH,NULL,NULL,hInst,NULL);

    ShowWindow(g_hwnd,SW_SHOWNOACTIVATE);
    SetTimer(g_hwnd,1,16,NULL);
    paint();

    std::thread t(pollThread); t.detach();

    MSG msg;
    while (GetMessage(&msg,NULL,0,0)) {
        TranslateMessage(&msg); DispatchMessage(&msg);
    }
    { std::lock_guard<std::mutex> lk(g_mutex); for(auto&s:g_sources) delete s.image; }
    GdiplusShutdown(gt);
    return 0;
}