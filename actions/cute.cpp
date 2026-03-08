#include <iostream>
#include <string>
#include <windows.h>

int main(int argc, char* argv[]) {
    std::string username = argc > 1 ? argv[1] : "";
    std::string message  = argc > 2 ? argv[2] : "";
    std::string args     = argc > 3 ? argv[3] : "";

    // --- YOUR CODE ---
srand((unsigned int)time(NULL));
int percent = rand() % 101;

std::string reply = username + " is " + std::to_string(percent) + "% cute! PogChamp";

WSADATA wsa;
WSAStartup(MAKEWORD(2,2), &wsa);
SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
sockaddr_in addr;
addr.sin_family = AF_INET;
addr.sin_port = htons(9001);
addr.sin_addr.s_addr = inet_addr("127.0.0.1");
connect(s, (sockaddr*)&addr, sizeof(addr));
send(s, reply.c_str(), reply.size(), 0);
closesocket(s);
WSACleanup();
WSACleanup();
    // --- END ---
    return 0;
}
