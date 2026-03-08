#include <iostream>
#include <string>
#include <fstream>
#include <sstream>
#include <vector>
#include <algorithm>
#include <winsock2.h>
#include <windows.h>
#include <cstdlib>
#include <ctime>

// ---- memory helpers ----
static std::string _memPath = "C:\\Users\\link\\Desktop\\learning\\chatcommander\\memory.json";

static std::string _getJsonField(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos = json.find(":", pos);
    if (pos == std::string::npos) return "";
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (json[pos] == '"') {
        pos++;
        std::string val;
        while (pos < json.size() && json[pos] != '"') {
            if (json[pos] == '\\') pos++;
            val += json[pos++];
        }
        return val;
    }
    std::string val;
    while (pos < json.size() && json[pos] != ',' && json[pos] != '}') val += json[pos++];
    while (!val.empty() && (val.back() == ' ' || val.back() == '\t')) val.pop_back();
    return val;
}

static std::string memGet(const std::string& key) {
    std::ifstream f(_memPath);
    if (!f.is_open()) return "";
    std::string json((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    f.close();
    return _getJsonField(json, key);
}

static void memSet(const std::string& key, const std::string& value) {
    std::string json = "{}";
    std::ifstream f(_memPath);
    if (f.is_open()) {
        json = std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        f.close();
    }
    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos != std::string::npos) {
        size_t end = json.find(',', pos);
        if (end == std::string::npos) {
            size_t prev = json.rfind(',', pos);
            if (prev != std::string::npos) pos = prev;
            json = json.substr(0, pos) + "\n}";
        } else {
            json = json.substr(0, pos) + json.substr(end + 1);
        }
    }
    std::string escaped;
    for (char c : value) {
        if (c == '"') escaped += "\\\"";
        else if (c == '\\') escaped += "\\\\";
        else escaped += c;
    }
    size_t closing = json.rfind('}');
    if (closing == std::string::npos) {
        json = "{\"" + key + "\": \"" + escaped + "\"}";
    } else {
        bool empty = json.substr(0, closing).find(':') == std::string::npos;
        if (empty) json = json.substr(0, closing) + "\"" + key + "\": \"" + escaped + "\"\n}";
        else json = json.substr(0, closing) + ",\n    \"" + key + "\": \"" + escaped + "\"\n}";
    }
    std::ofstream out(_memPath);
    out << json;
    out.close();
}
// ---- end memory helpers ----

int main(int argc, char* argv[]) {
    std::string username = argc > 1 ? argv[1] : "";
    std::string message  = argc > 2 ? argv[2] : "";
    std::string args     = argc > 3 ? argv[3] : "";
    std::string channel  = argc > 4 ? argv[4] : "";

    // --- YOUR CODE ---
#include <vector>
#include <algorithm>

auto sendToChat = [&](const std::string& msg) {
    WSADATA wsa;
    WSAStartup(MAKEWORD(2,2), &wsa);
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a;
    a.sin_family = AF_INET;
    a.sin_port = htons(9001);
    a.sin_addr.s_addr = inet_addr("127.0.0.1");
    connect(s, (sockaddr*)&a, sizeof(a));
    send(s, msg.c_str(), msg.size(), 0);
    closesocket(s);
    WSACleanup();
};

auto getCash = [&](const std::string& user) -> long long {
    std::string val = memGet("cash_" + user);
    if (val.empty()) { memSet("cash_" + user, "25"); return 25; }
    return std::stoll(val);
};
auto setCash = [&](const std::string& user, long long amount) {
    memSet("cash_" + user, std::to_string(amount));
};

// default bet = 10% of cash, min $1
auto defaultBet = [&](long long cash) -> long long {
    long long bet = cash / 10;
    return bet < 1 ? 1 : bet;
};

// ---- PARSE ARGS ----
std::string sub = "";
std::string arg1 = "";
std::string arg2 = "";
std::istringstream argStream(args);
argStream >> sub >> arg1 >> arg2;

srand((unsigned int)time(nullptr) ^ (unsigned int)(uintptr_t)&sub);

// ---- COINFLIP ----
if (sub == "coinflip" || sub == "cf") {
    long long cash = getCash(username);
    long long bet = arg1.empty() ? defaultBet(cash) : std::stoll(arg1);
    if (bet <= 0) {
        sendToChat("@" + username + " invalid amount.");
    } else if (bet > cash) {
        sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 You have $" + std::to_string(cash));
    } else {
        bool win = (rand() % 2) == 0;
        if (win) {
            setCash(username, cash + bet);
            sendToChat("@" + username + " won $" + std::to_string(bet) + "! \xF0\x9F\x92\xB5 $" + std::to_string(cash + bet));
        } else {
            setCash(username, cash - bet);
            sendToChat("@" + username + " \xF0\x9F\x98\x9E lost $" + std::to_string(bet) + ". \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
        }
    }
}

// ---- SLOTS ----
else if (sub == "slots" || sub == "slot") {
    long long cash = getCash(username);
    long long bet = arg1.empty() ? defaultBet(cash) : std::stoll(arg1);
    if (bet <= 0) {
        sendToChat("@" + username + " invalid amount.");
    } else if (bet > cash) {
        sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 You have $" + std::to_string(cash));
    } else {
        sendToChat("@" + username + " \xF0\x9F\x8E\xB0 Spinning...");
        Sleep(3000);

        std::vector<std::string> symbols = {
            "\xF0\x9F\x8D\x92", // 🍒
            "\xF0\x9F\x8D\x8B", // 🍋
            "\xF0\x9F\x8D\x8A", // 🍊
            "\xF0\x9F\x8D\x87", // 🍇
            "\xE2\xAD\x90",     // ⭐
            "\xF0\x9F\x92\x8E", // 💎
            "\x37\xEF\xB8\x8F\xE2\x83\xA3" // 7️⃣
        };

        auto rollReel = [&]() -> int {
            int r = rand() % 18;
            if (r < 3) return 0;
            if (r < 6) return 1;
            if (r < 9) return 2;
            if (r < 12) return 3;
            if (r < 15) return 4;
            if (r < 17) return 5;
            return 6;
        };

        int r1 = rollReel();
        int r2 = rollReel();
        int r3 = rollReel();
        std::string display = "\xF0\x9F\x8E\xB0 [ " + symbols[r1] + " | " + symbols[r2] + " | " + symbols[r3] + " ] ";

        if (r1 == r2 && r2 == r3) {
            long long payout = 0;
            std::string resultMsg = "";
            if (r3 == 6)      { payout = bet * 10; resultMsg = "JACKPOT!! \x37\xEF\xB8\x8F\xE2\x83\xA3"; }
            else if (r3 == 5) { payout = bet * 7;  resultMsg = "\xF0\x9F\x92\x8E\xF0\x9F\x92\x8E\xF0\x9F\x92\x8E"; }
            else if (r3 == 4) { payout = bet * 4;  resultMsg = "\xE2\xAD\x90\xE2\xAD\x90\xE2\xAD\x90"; }
            else              { payout = bet * 3;  resultMsg = "Three of a kind!"; }
            setCash(username, cash + payout);
            sendToChat(display + resultMsg + " @" + username + " won $" + std::to_string(payout) + "! \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
        } else if (r1 == r2 || r2 == r3 || r1 == r3) {
            sendToChat(display + "@" + username + " two of a kind — bet returned. \xF0\x9F\x92\xB5 $" + std::to_string(cash));
        } else {
            setCash(username, cash - bet);
            sendToChat(display + "@" + username + " \xF0\x9F\x98\x9E lost $" + std::to_string(bet) + ". \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
        }
    }
}

// ---- ROULETTE ----
else if (sub == "roulette" || sub == "rl") {
    if (arg2.empty()) {
        sendToChat("@" + username + " usage: !gamble roulette <amount> <red|black|green>");
    } else {
        long long cash = getCash(username);
        long long bet = arg1.empty() ? defaultBet(cash) : std::stoll(arg1);
        if (bet <= 0) {
            sendToChat("@" + username + " invalid amount.");
        } else if (bet > cash) {
            sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 You have $" + std::to_string(cash));
        } else {
            int spin = rand() % 37;
            std::vector<int> reds = {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36};
            bool isRed = std::find(reds.begin(), reds.end(), spin) != reds.end();
            bool isGreen = (spin == 0);
            bool isBlack = !isRed && !isGreen;
            std::string color = isGreen ? "\xF0\x9F\x9F\xA2 " : (isRed ? "\xF0\x9F\x94\xB4 " : "\xE2\x9A\xAB ");
            std::string spinStr = color + std::to_string(spin);

            bool win = false;
            long long payout = 0;
            if (arg2 == "red" && isRed)     { win = true; payout = bet; }
            else if (arg2 == "black" && isBlack) { win = true; payout = bet; }
            else if (arg2 == "green" && isGreen) { win = true; payout = bet * 14; }

            if (win) {
                setCash(username, cash + payout);
                sendToChat("@" + username + " " + spinStr + " won $" + std::to_string(payout) + "! \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
            } else {
                setCash(username, cash - bet);
                sendToChat("@" + username + " " + spinStr + " \xF0\x9F\x98\x9E lost $" + std::to_string(bet) + ". \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
            }
        }
    }
}

// ---- HELP ----
else {
    sendToChat("@" + username + " \xF0\x9F\x8E\xB0 !gamble coinflip [amt] | slots [amt] | roulette <amt> <red|black|green>");
}
    // --- END ---
    return 0;
}
