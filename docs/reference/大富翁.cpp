#include <iostream>
#include <string>
#include <vector>
#include <thread> 
#include <ctime>
#include <chrono>
#include <cstdlib>
#include <random>
#include <cmath>
#include <windows.h> 
#include <limits> 
#include <ctime>
using namespace std;
// 设置控制台光标位置
void gotoxy(int x, int y) {
	COORD coord;
	coord.X = x;
	coord.Y = y;
	SetConsoleCursorPosition(GetStdHandle(STD_OUTPUT_HANDLE), coord);
}

// 清除控制台
void clearScreen() {
	system("cls");
}

// 模拟一个ASCII烟花
void asciiFirework(int startX, int startY) {
	// 1. 升空阶段
	for (int y = startY; y > startY / 2; y--) {
		gotoxy(startX, y);
		cout << "o";
		Sleep(30); // 延迟
		gotoxy(startX, y);
		cout << " "; // 擦除
	}

	// 2. 爆炸阶段
	// 定义爆炸的形状
	vector<string> explosion = {
		"  *  ",
		" * * ",
		"*****",
		" * * ",
		"  *  "
	};

	int centerX = startX;
	int centerY = startY / 2;

	// 绘制爆炸效果
	for (int i = 0; i < explosion.size(); i++) {
		gotoxy(centerX - 2, centerY - 2 + i);
		cout << explosion[i];
	}
	Sleep(500); // 停留一会儿

	// 3. 消失阶段
	for (int i = 0; i < explosion.size(); i++) {
		gotoxy(centerX - 2, centerY - 2 + i);
		cout << "     "; // 用空格擦除
	}
}
int firework();
int firework() {
	// 隐藏光标，让效果更好
	CONSOLE_CURSOR_INFO cursorInfo;
	GetConsoleCursorInfo(GetStdHandle(STD_OUTPUT_HANDLE), &cursorInfo);
	cursorInfo.bVisible = false;
	SetConsoleCursorInfo(GetStdHandle(STD_OUTPUT_HANDLE), &cursorInfo);

	srand(time(0)); // 初始化随机数种子
	clearScreen();

	// 连续放几个烟花
	for (int i = 0; i < 5; i++) {
		int x = rand() % 60 + 10; // 随机X坐标
		int y = rand() % 10 + 20; // 随机Y坐标
		asciiFirework(x, y);
		Sleep(500); // 烟花之间的间隔
	}

	cout << "烟花表演结束！" << endl;
	return 0;
}
void showSimpleFireworks() {
	cout << "\n\n\n";
	cout << "    ***** 游戏结束 *****    \n";
	cout << "   ***  感谢参与！  ***   \n";
	cout << "  **    下次再战！    **  \n";
	cout << " *                    * \n";
	cout << "*  按Enter键退出游戏   * \n";
	cout << " *                    * \n";
	cout << "  **                  **  \n";
	cout << "   ***              ***   \n";
	cout << "    *****        *****    \n";
	cout << "       **********        \n\n";
}
void showGameRules();
// 全局变量，用于记录游戏回合数
static int num = 0;
// 玩家类
class player
{
public:
	string id, name;   // 玩家ID和姓名
	bool alive, credit,inbankloan; // 玩家是否存活和信用状况
	float gold, borrow, lend; // 玩家金币、总欠款、总放贷金额

	// 构造函数，初始化玩家状态
	player() { alive = true; gold = 100; borrow = 0; lend = 0; credit = true; inbankloan = false; }

	// 成员函数声明
	void financialshow();       // 显示财务状况
	void initiativerepay();     // 主动还款
	void dun();                 // 催债           
};

// 创建10个玩家的全局数组
player A[10];

// 显示玩家财务状况的实现
void player::financialshow() {
	cout << "\n===== 玩家 " << name << " 财务状况 =====" << endl;
	cout << "| 指标         | 数值       | 状态说明               |" << endl;
	cout << "|--------------|------------|------------------------|" << endl;
	cout << "| 金币         | " << gold << "       | " << (gold < 20 ? "资金紧张" : "余额充足") << " |" << endl;
	cout << "| 总欠款       | " << borrow << "       | " << (borrow > 0 ? "存在负债" : "无负债") << " |" << endl;
	cout << "| 总放贷       | " << lend << "       | " << (lend > 0 ? "有应收款项" : "无放贷") << " |" << endl;
	cout << "| 信用状况     | " << (credit ? "良好" : "失信") << "       | " << (credit ? "" : "已被银行拉黑") << " |" << endl;
	cout << "| 银行贷款状态 | " << (inbankloan ? "在贷" : "无贷") << "       | " << (inbankloan ? "需按期还款" : "") << " |" << endl;
	cout << "==============================" << endl;
}

// 银行贷款类（借条）
class loanbank
{
public:
	player* A = nullptr; // 指向借款的玩家
	float gold;          // 当前欠款总额（含利息）
	bool effect;         // 借条是否有效（未还清）
	int time;            // 借款发生的回合数

	// 构造函数
	loanbank(float gold1 = 0) : gold(gold1) { time = num; effect = false; }

	// 设置一笔新的银行贷款
	void setin(player* A1, float gold1 = 0, int time1 = 1)
	{
		A = A1; gold = gold1; time = time1;
		effect = true; cout << A->name << "已向银行贷款" << gold << "元" << endl;
		system("pause");
	}

	// 计算利息（每回合增加10%）
	void change()
	{
		A->borrow -= gold; // 从玩家总欠款中减去旧的欠款额
		gold = gold * 1.1; // 计算新利息
		A->borrow += gold; // 将新的欠款额加到玩家总欠款中
	}

	// 显示借条信息
	void show()
	{
		cout << "借款人：" << A->name << endl << "需要偿还的债务：" << gold << endl;
	}

	// 强制还款逻辑（借款超过3回合后触发）
	
};

// 玩家间借贷类（借条）
class loanplayer
{
public:
	player* A = nullptr, * B = nullptr; // A是借款人，B是出借人
	float rate, money;                 // 利率和本金
	bool effect;                       // 借条是否有效
	int time;                          // 借款发生的回合数

	// 构造函数
	loanplayer() { money = 0; rate = 0; effect = false; time = num; }

	// 设置一笔新的玩家间借贷
	void setin(player* A1, player* B1, float rate1, float money1, int time1)
	{
		A = A1; B = B1; rate = rate1; money = money1; time = time1; effect = true;
	}

	// 计算利息
	void change()
	{
		A->borrow -= money; // 更新借款人的总欠款
		B->lend -= money;   // 更新出借人的总放贷
		money = money * (1 + rate); // 计算新的本息总额
		A->borrow += money; // 更新借款人的总欠款
		B->lend += money;   // 更新出借人的总放贷
	}
	// 显示玩家间借贷信息的函数
	void show()
	{
		cout << "借款人：" << A->name << "，出借人：" << B->name << endl << "需要偿还的债务：" << money << endl;
	}
	// 强制提前还款逻辑（由出借人发起）
	void PrepayCompulsory()
	{
		float ask;
		// 检查借款是否未满一轮（time == num 表示刚借出）
		if (time == num)
			cout << "借款未满一轮，不能强制还款" << endl;
		do {
			cout << "当前借款总数目（含利息）" << money << endl;
			cout << A->name << "可用于还款的资金:" << A->gold << endl;
			cout << "请" << B->name << "输入你要求" << A->name << "强制还款的数目";
			cin >> ask;
			if (ask > money)
				cout << "借款数目不足！请重新输入" << endl;
			if (ask > A->gold) cout << A->name << "没有足够资金偿还！请重新输入" << endl;
		} while (ask > money || ask > A->gold);
		float as = money;
		money -= ask;
		if (money <= 0)
		{
			cout << "借款已全部偿还，此借条作废" << endl;
			effect = false; A->borrow -= as; B->lend -= as; money = 0; A->gold = A->gold - as;
			B->gold += as;
		}
		else
		{
			cout << B->name << "已收回了对" << A->name << "的部分借款" << endl;
			A->borrow -= as; B->lend -= as; A->gold = A->gold - ask;
			B->gold += ask;
		}
	}
}; // loanplayer 类结束

// 定义银行贷款记录数组，最大100条
loanbank bankloan[200];
static int bln = 0; // 银行贷款记录计数器

// 定义玩家借贷记录数组，最大100条
loanplayer playerloan[200];
static int pln = 0; // 玩家借贷记录计数器
static void repayCompulsory(loanbank* X) {
	if (X->time <= num - 3) {
		int i;
		float repayment = X->gold;  // 保存原始欠款额
		cout << X->A->name << "，你的银行贷款到期了，是否还款？（1是/0拒绝）" << endl;
		cin >> i;
		if (i) {
			if (X->A->gold >= repayment) {
				X->A->gold -= repayment;
				X->A->borrow -= repayment;  // 修正：减去还款额（非X->gold）
				cout << X->A->name << "还款成功！此借条作废" << endl;
				X->gold = 0;
				X->effect = false;
				// 检查是否还有其他贷款
				bool hasOtherLoan = false;
				for (int bsd = 0; bsd < bln; bsd++) {
					if (bankloan[bsd].effect && bankloan[bsd].A->id == X->A->id) {
						hasOtherLoan = true; break;
					}
				}
				if (!hasOtherLoan) X->A->inbankloan = false;
			}
			else {
				cout << X->A->name << "余额不足，已被银行拉黑" << endl;
				X->effect = false;
				X->A->credit = false;
				X->A->borrow -= repayment;  // 修正：减去原始欠款额
				X->gold = 0;  // 修正空格
				// 标记所有该玩家的贷款失效
				for (int bsd = 0; bsd < bln; bsd++) {
					if (bankloan[bsd].effect && bankloan[bsd].A->id == X->A->id) {
						bankloan[bsd].effect = false;  // 修正赋值运算符
					}
				}
			}
		}
		else {
			cout << X->A->name << "拒绝还款，已被银行拉黑" << endl;
			X->effect = false;
			X->A->credit = false;
			X->A->borrow -= repayment;  // 修正：减去原始欠款额
			X->gold = 0;  // 修正空格
			for (int bsd = 0; bsd < bln; bsd++) {
				if (bankloan[bsd].effect && bankloan[bsd].A->id == X->A->id) {
					bankloan[bsd].effect = false;  // 修正赋值运算符
				}
			}
		}
	}
}
// 玩家主动还款函数实现
void player::initiativerepay() {
	int j, k = 0;
	cout << "你要偿还银行借款还是私人借款？（1银行/0私人）";
	cin >> j;

	// ==============================
	// 分支1：偿还银行贷款（修复版）
	// ==============================
	if (j) {
		int flag[100] = { 0 };  // 修复1：扩容至100（与bankloan数组一致，避免越界）
		// 修复2：循环条件用i < bln（仅遍历有效记录，避免越界）
		for (int i = 0; i < bln; i++) {
			// 修复3：增加effect检查（仅处理未还清贷款）
			if (bankloan[i].effect && id == bankloan[i].A->id) {
				flag[k] = i;
				k++;
			}
		}

		if (k == 0) {  // 无贷款时提示
			cout << "你没有需要偿还的银行贷款" << endl;
		}
		else {
			int b;
			float p;
			// 显示所有有效银行贷款
			cout << "以下是你的所有银行贷款：" << endl;
			for (int n = 0; n < k; n++) {
				bankloan[flag[n]].show();
			}
			// 选择贷款序号（修复4：限制b在1~k之间）
			cout << "你要偿还哪一笔？（1~" << k << "）：";
			cin >> b;
			b = (b < 1) ? 1 : (b > k ? k : b);  // 简化边界判断
			cout << "这是你准备偿还的债务：" << endl;
			bankloan[flag[b - 1]].show();

			// 输入还款金额（修复5：处理非数字输入，避开numeric_limits）
			do {
				cout << "你要还多少钱？";
				if (!(cin >> p)) {  // 检查输入是否为数字
					cin.clear();  // 清除错误状态
					// 修复6：用固定长度1024忽略缓冲（替代numeric_limits）
					cin.ignore(1024, '\n');
					p = -1;  // 设为无效值
					cout << "输入无效（需数字），请重新输入！" << endl;
				}
				else if (p < 0) {  // 金额不能为负
					cout << "金额不能为负，请重新输入！" << endl;
				}
				else if (p > gold) {  // 资金不足
					cout << "你的资金不足（当前余额：" << gold << "），请重新输入！" << endl;
				}
			} while (p < 0 || p > gold);  // 循环直到输入有效

			// 处理还款（全额/部分）
			if (p >= bankloan[flag[b - 1]].gold) {  // 全额还款
				float repayment = bankloan[flag[b - 1]].gold;
				gold -= repayment;
				borrow -= repayment;  // 总欠款减少
				bankloan[flag[b - 1]].gold = 0;
				bankloan[flag[b - 1]].effect = false;  // 标记贷款失效

				// 检查是否还有其他有效贷款（更新inbankloan状态）
				bool hasOtherLoan = false;
				for (int i = 0; i < bln; i++) {
					if (bankloan[i].effect && bankloan[i].A->id == id) {
						hasOtherLoan = true;
						break;
					}
				}
				if (!hasOtherLoan) inbankloan = false;  // 无其他贷款时更新状态

				cout << "此债务已全部偿还，借条作废。" << endl;
			}
			else {  // 部分还款
				bankloan[flag[b - 1]].gold -= p;  // 贷款剩余金额减少
				gold -= p;
				borrow -= p;  // 总欠款减少
				cout << "已偿还部分债务（剩余：" << bankloan[flag[b - 1]].gold << "金币）。" << endl;
			}
		}
	}

	// ==============================
	// 分支2：偿还私人借款（修复版，逻辑同银行）
	// ==============================
	else {
		int flag[100] = { 0 };  // 修复1：扩容至100（与playerloan数组一致）
		// 修复2：循环条件用i < pln（仅遍历有效记录）
		for (int i = 0; i < pln; i++) {
			// 修复3：增加effect检查（仅处理未还清贷款）
			if (playerloan[i].effect && id == playerloan[i].A->id) {
				flag[k] = i;
				k++;
			}
		}

		if (k == 0) {  // 无私人借款时提示
			cout << "你没有需要偿还的私人借款" << endl;
		}
		else {
			int b;
			float p;
			// 显示所有有效私人借款
			cout << "以下是你的所有私人借款：" << endl;
			for (int n = 0; n < k; n++) {
				playerloan[flag[n]].show();
			}
			// 选择借款序号（修复4：限制b在1~k之间）
			cout << "你要偿还哪一笔？（1~" << k << "）：";
			cin >> b;
			b = (b < 1) ? 1 : (b > k ? k : b);  // 简化边界判断
			cout << "这是你准备偿还的债务：" << endl;
			playerloan[flag[b - 1]].show();

			// 输入还款金额（修复5：处理非数字输入，避开numeric_limits）
			do {
				cout << "你要还多少钱？";
				if (!(cin >> p)) {  // 检查输入是否为数字
					cin.clear();  // 清除错误状态
					// 修复6：用固定长度1024忽略缓冲（替代numeric_limits）
					cin.ignore(1024, '\n');
					p = -1;  // 设为无效值
					cout << "输入无效（需数字），请重新输入！" << endl;
				}
				else if (p < 0) {  // 金额不能为负
					cout << "金额不能为负，请重新输入！" << endl;
				}
				else if (p > gold) {  // 资金不足
					cout << "你的资金不足（当前余额：" << gold << "），请重新输入！" << endl;
				}
			} while (p < 0 || p > gold);  // 循环直到输入有效

			// 处理还款（全额/部分）
			if (p >= playerloan[flag[b - 1]].money) {  // 全额还款
				float repayment = playerloan[flag[b - 1]].money;
				gold -= repayment;
				borrow -= repayment;  // 总欠款减少
				// 出借人收回资金
				playerloan[flag[b - 1]].B->gold += repayment;
				playerloan[flag[b - 1]].B->lend -= repayment;  // 出借人放贷额减少
				// 标记贷款失效
				playerloan[flag[b - 1]].money = 0;
				playerloan[flag[b - 1]].effect = false;
				cout << "此债务已全部偿还，借条作废。" << endl;
			}
			else {  // 部分还款
				playerloan[flag[b - 1]].money -= p;  // 借款剩余金额减少
				gold -= p;
				borrow -= p;  // 总欠款减少
				// 出借人收回部分资金
				playerloan[flag[b - 1]].B->gold += p;
				playerloan[flag[b - 1]].B->lend -= p;  // 出借人放贷额减少
				cout << "已偿还部分债务（剩余：" << playerloan[flag[b - 1]].money << "金币）。" << endl;
			}
		}
	}
}
// 函数声明（同步修改参数名）
void privateborrow(player* borrower, int playnum);

// 函数定义（修复后）
void privateborrow(player* borrower, int playnum) {
	player* B = nullptr; // 放贷人指针
	string name;

	cout << "借贷人（借款人）：" << borrower->name << endl;
	cout << "请输入放贷人（出借人）的姓名：";
	cin >> name;

	// 关键修复：遍历全局玩家数组A[10]，而非参数borrower
	for (int i = 0; i < playnum; i++) {
		// 条件：存活、姓名匹配、不是当前借款人自己
		if (A[i].alive && A[i].name == name && &A[i] != borrower) {
			B = &A[i];
			break;
		}
	}

	if (B == nullptr) {
		cout << "\n错误：未找到符合条件的出借人" << endl;
		cout << "解决步骤：" << endl;
		cout << "1. 确认姓名拼写正确（区分大小写）" << endl;
		cout << "2. 确认出借人处于存活状态（未破产）" << endl;
		cout << "3. 确认出借人不是你自己" << endl;
		return;
	}

	// 后续逻辑（金额、利率输入，资金转移，借条生成）保持不变...
	float money, rate;
	cout << "请输入借款金额：";
	cin >> money;
	if (money <= 0) { cout << "金额无效，交易取消。" << endl; return; }
	if (money >B->gold) { cout <<B->name << "没有这么多现金，金额无效，交易取消。" << endl; return; }

	do {
		cout << "请输入每回合利率（0~1之间，如0.1代表10%）：";
		cin >> rate;
	} while (rate < 0 || rate > 1);

	// 生成借条（使用全局数组playerloan）
	playerloan[pln].setin(borrower, B, rate, money, num);
	// 资金转移：借款人加钱，放贷人减钱
	borrower->gold += money;
	B->gold -= money;
	// 更新借条计数器
	borrower->borrow += money; 
	B->lend += money;
	pln++;
	cout << "交易成功！" << borrower->name << " 从 " << B->name << " 处借得 " << money << " 金币。" << endl;
}

// 函数声明：银行贷款功能
void bankborrow(player& A);

// 函数定义：银行贷款功能
void bankborrow(player& A)
{ // 使用引用传递，更方便修改原对象
	if (A.inbankloan == true)
		cout << "你已处于银行借款状态中，不可重复向银行借贷" << endl;
	else {
		cout << "借贷人（借款人）：" << A.name << endl;

		// 计算可借上限（假设规则为：当前金币的50%）
		float maxLoan = A.gold * 0.5;
		float amount;
		if (A.gold == 0)
			cout << "你资金为0，银行拒绝向你提供贷款！" << endl;
		else {
			cout << "当前持有金币：" << A.gold << endl;
			cout << "（系统规则：本次最多可向银行贷款 " << maxLoan << " 金币）" << endl;
			cout << "请输入借贷金额：";

			// 输入并验证金额
			while (true) {
				cin >> amount;
				if (amount > maxLoan) {
					cout << "贷款金额超出限额！请输入小于等于 " << maxLoan << " 的金额：";
				}
				else if (amount <= 0) {
					cout << "请输入大于 0 的金额：";
				}
				else {
					break;
				}
			}

			// 更新玩家金币（增加贷款金额）
			A.gold += amount;
			A.borrow += amount; // 更新玩家总债务记录

			// 创建银行贷款记录，传入借款人地址、金额和当前回合数
			bankloan[bln].setin(&A, amount, num);

			// 更新全局银行贷款计数器
			bln++;
			A.inbankloan = true;
			cout << A.name << " 成功向银行贷款 " << amount << " 金币！" << endl;
			cout << "新的财务状况：" << endl;
			A.financialshow(); // 显示更新后的财务状况
		}
	}
}
// 催债函数
void player::dun()
{
	int count = 0; // 记录该玩家作为债权人的借贷记录数量
	int indices[30]; // 存储这些借贷记录在 playerloan 数组中的索引

	// 1. 遍历所有借贷记录，找出别人欠自己的钱
	for (int i = 0; i < pln; i++)
	{
		// 如果借条有效，且自己是出借人 (B)
		if (playerloan[i].effect == true && playerloan[i].B == this)
		{
			indices[count] = i;
			count++;
		}
	}

	// 2. 如果没有放贷记录，直接返回
	if (count == 0)
	{
		cout << "你没有放贷给任何玩家，无法催债。" << endl;
		return;
	}

	// 3. 显示所有欠款信息
	cout << "以下是所有欠你钱的玩家及金额：" << endl;
	for (int i = 0; i < count; i++)
	{
		playerloan[indices[i]].show();
	}

	// 4. 选择要催债的对象
	int choice;
	cout << "请选择要催债的记录（输入序号）：";
	cin >> choice;

	// 简单的输入校验
	if (choice < 1 || choice > count)
	{
		cout << "无效的选择！" << endl;
		return;
	}

	// 获取选中的借贷记录索引
	int loanIndex = indices[choice - 1];

	// 5. 调用该记录的强制还款函数
	// 在 PrepayCompulsory 函数中，会由出借人（也就是 this）发起，要求借款人（A）还款
	playerloan[loanIndex].PrepayCompulsory();
	system("pause");
}

// 玩家回合选择函数（目前为空）
// 玩家行动选择函数（普通函数版本）
// 参数 p: 当前行动的玩家引用
// 参数 playnum: 玩家总数（用于向玩家借款时遍历数组）
void choose(player& p, int playnum);
void choose(player& p, int playnum)
{
	if (!p.alive) return;
	cout << "\n--- 【" << p.name << "的回合】 ---" << endl;
	cout << "当前状态：";
	if (p.gold < 20) cout << "资金紧张（低于纳税阈值）";
	else cout << "状态正常";
	int choice;
	bool inputValid = false; // 标记输入是否合法

	// 循环直到输入合法
	do {
		cout << "\n请选择行动(注意：除回看游戏规则外，您只有一次行动机会！)：" << endl;
		cout << "【1】 向银行借款（需未负债，最多借当前金币50%）" << endl;
		cout << "【2】 向玩家借款（需指定存活出借人，利率0-1）" << endl;
		cout << "【3】 催债（强制收回私人借款，需借款满1回合）" << endl;
		cout << "【4】 主动还款（选择银行/私人债务，支持部分还款）" << endl;
		cout << "【5】 回看游戏规则并查看自身状态" << endl;
		cout << "【6】 结束行动" << endl;
		cout << "请输入选项 (1-6): ";

		// 1. 检查是否为数字输入
			if (cin >> choice) {
				// 2. 检查是否在1-5范围内
				if (choice >= 1 && choice <= 6) {
					inputValid = true; // 输入合法，退出循环
				}
				else {
					cout << "选项必须在1-6之间，请重新输入！" << endl;
				}
			}
			else {
				// 输入非数字时的错误处理（避开numeric_limits）
				cin.clear(); // 清除cin错误状态
				cin.ignore(1024, '\n'); // 用固定长度1024忽略缓冲区（替代max）
				cout << "输入无效（需为数字）！请重新输入。" << endl;
			}
			if (choice == 5)
			{
				showGameRules();
				system("pause");
				p.financialshow();
				system("pause");
			}
	} while (!inputValid||choice==5); // 输入合法后才退出循环

	// 执行对应行动（原switch逻辑不变）
	switch (choice)
	{
	case 1:
		bankborrow(p);
		break;
	case 2:
		privateborrow(&p, playnum);
		break;
	case 3:
		p.dun();
		break;
	case 4:
		p.initiativerepay();
		break;
	case 6:
		cout << "结束本轮操作。" << endl;
		break; // 输入5时，正常结束
	default:
		cout << "无效选项（理论上不会触发）。" << endl;
		break;
	}
}
// 危险状态下的选择函数
// 危险状态下的紧急选择函数
// 参数 p: 当前处于危险状态的玩家引用
// 参数 playnum: 玩家总数
void dangerchoose(player& p, int playnum);
void dangerchoose(player& p, int playnum)
{
	if (!p.alive) return;

	int choice;
	cout << "\n!!! 警告：玩家 " << p.name << " 资金不足，处于破产边缘 !!!" << endl;
	cout << "当前余额：" << p.gold << endl;
	cout << "如果不进行紧急操作填补资金缺口，你将被淘汰！" << endl;

	cout << "请选择紧急自救方式：" << endl;
	cout << "1. 紧急向其他玩家借款" << endl;
	cout << "2. 立即强制收回借款 (催债)" << endl;
	cout << "3. 放弃抵抗 (直接淘汰)" << endl;
	cout << "请输入选项 (1-3): ";
	cin >> choice;

	switch (choice)
	{
	case 1:
	{
		// 调用私人借贷函数尝试借钱
		// 注意：这里传入 p 的地址，因为 privateborrow 需要修改 p 的金币
		privateborrow(&p, playnum);
		break;
	}
	case 2:
	{
		// 调用催债函数尝试回笼资金
		p.dun();
		break;
	}
	case 3:
	{
		cout << p.name << " 选择放弃，遗憾离场。" << endl;
		p.alive = false;
		break;
	}
	default:
		cout << "无效操作，视为放弃抵抗。" << endl;
		p.alive = false;
		break;
	}
}
void showGameRules() {
	cout << "\n===== 大富翁游戏核心规则 =====" << endl;
	cout << "【目标】通过管理财务（借款/还款/催债）成为最后存活玩家（大富翁）" << endl;

	cout << "\n----- 玩家属性 -----" << endl;
	cout << "- 初始金币: 100 | 信用: 良好 | 存活: 是" << endl;
	cout << "- 金币<0 → 破产（退出） | 金币<20 → 资金紧张" << endl;

	cout << "\n----- 借贷规则 -----" << endl;
	cout << "1. 银行贷款: 无负债时可借（≤当前金币50%），每回合利息10%，超3回合强制还款" << endl;
	cout << "   - 还款成功: 借条作废 | 拒绝/不足: 信用变失信（无法再借)" << endl;
	cout << "2. 私人借贷: 找存活玩家出借，利率0-1（如0.1=10%/回合），满1回合可催债" << endl;

	cout << "\n----- 经济机制 -----" << endl;
	cout << "- 利息结算: 每回合自动算（银行10%、私人按约定），更新欠款/放贷" << endl;
	cout << "- 税收: 每3回合扣20金币，不足进危险状态（可借款/催债自救，失败则破产）" << endl;
	cout << "- 赌博: 猜0/1，赢本金（杠杆双倍），输本金（杠杆双倍），余额<0转银行贷款" << endl;

	cout << "\n----- 阶段流程（每回合）-----" << endl;
	cout << "1. 利息结算 → 2. 银行逾期检查 → 3. 看财务 → 4. 玩家行动 → 5. 赌博 → 6. 纳税（每3回合）" << endl;

	cout << "\n----- 胜负判定 -----" << endl;
	cout << "- 胜: 其他玩家全破产，仅剩1人" << endl;
	cout << "- 败: 自身破产（金币<0且自救失败）" << endl;
	cout << "==============================" << endl;
}
// 游戏控制类
class game
{
public:
	game() {}
	void start();           // 游戏主循环
	void tax(player& b);    // 税收功能
	void gamble(int number);// 赌博功能
};

// 赌博功能实现
void game::gamble(int number)
{
	float fund[10] = { 0 }; // 存储每个玩家的赌注金额
	int b[10] = { 0 };      // 存储每个玩家是否使用杠杆（数组名b与之前代码风格保持一致）
	int c[10] = { 0 };      // 存储每个玩家猜测的结果（0或1）

	// 1. 收集所有存活玩家的赌注和下注信息
	for (int i = 0; i < number; i++)
	{
		if (A[i].alive == true)
		{
			// 输入赌注并校验余额
			do {
				cout << "玩家" << A[i].name << "可用于赌博的资金：" << A[i].gold << endl;
				cout << "请玩家" << i << A[i].name << "输入赌博金额" << "：";
				cin >> fund[i];
				if (fund[i] > A[i].gold)
					cout << "金币不足，请重新输入" << endl;
			} while (fund[i] > A[i].gold);

			// 询问是否使用双倍杠杆
			if (A[i].credit == true) {
				cout << "是否使用双倍杠杆？（是1/否0）" << endl;
				cin >> b[i];
			}
			else
				b[i] = 0;
			// 询问猜测结果
			cout << "你赌这次是几点？（1或0）" << endl;
			cin >> c[i];

			system("pause"); // 暂停以便玩家确认
		}
	}

	// 2. 生成随机结果 (0 或 1)
	std::random_device rd;
	std::mt19937 gen(rd());
	std::uniform_int_distribution<> distrib(0, 1);
	int result = distrib(gen);
	std::cout << "开盅结果: " << result << std::endl;

	// 3. 结算输赢
	for (int i = 0; i < number; i++)
	{
		if (A[i].alive == true)
		{
			if (c[i] == result) // 猜对了
			{
				if (b[i]==1) // 使用了杠杆，赢双倍
					A[i].gold += 2 * fund[i];
				else           // 没用杠杆，赢本金
					A[i].gold += fund[i];
				cout << A[i].name << "猜对了！" << endl;
			}
			else // 猜错了
			{
				cout << A[i].name << "猜错了！" << endl;
				if (b[i] == 1) // 使用了杠杆，输双倍
					A[i].gold -= 2 * fund[i];
				else           // 没用杠杆，输本金
					A[i].gold -= fund[i];

				// 如果余额不足（破产），自动转为银行贷款
				if (A[i].gold < 0)
				{
					float j = -A[i].gold; // 计算欠款金额
					A[i].gold = 0;        // 金币归零
					// 生成一笔银行贷款
					bankloan[bln].setin(&A[i], j, num);
					A[i].borrow += j;     // 更新玩家总欠款
					bln++;                // 银行贷款记录数+1
					A[i].inbankloan = true;
					cout << A[i].name << "您已欠银行" << j << "金币，已自动生成一笔贷款" << endl;
				}
			}
			A[i].financialshow(); // 显示当前财务状况
			system("pause");
		}
	}
}

// 税收功能实现
void game::tax(player& b)
{
	b.gold -= 20; // 扣除20金币税款

	// 如果扣税后余额不足
	if (b.gold < 0)
	{
		// 修改点1：直接传 b (引用)，不要取地址 &
		// 修改点2：利用 sizeof(A)/sizeof(player) 动态获取数组最大容量作为 playnum
		// 这样就不需要在 tax 函数里额外传参，也不用担心 playnum 作用域问题
		dangerchoose(b, sizeof(A) / sizeof(player));

		// 如果经过危险选择后仍然没钱
		if (b.gold < 0)
			b.alive = false; // 玩家死亡/破产

		// 建议：只有在真正破产时才输出破产信息，否则只是“资金紧张”
		if (!b.alive)
			cout << b.name << "已破产" << endl;
	}

	// 如果没破产，提示收税成功即可，不用每次都喊破产
	if (b.alive)
		cout << "对" << b.name << "收税结束，当前余额：" << b.gold << endl;
	else
		cout << "对" << b.name << "收税结束" << endl;
}

// 游戏主循环
void game::start()
{
	cout << "----------------欢迎来到大富翁----------------" << endl;
	system("pause");
	cout << "请详细阅读规则说明" << endl;
	system("pause");
	showGameRules();
	system("pause");
	for (int i = 0; i < 10; i++) {
		A[i] = player();  // 调用默认构造函数重置
		A[i].id = i;
	}
	int playnum;
	cout << "请输入玩家个数(2~10人)：";
	cin >> playnum;

	// 简单校验人数
	if (playnum < 2 || playnum > 10) {
		cout << "人数输入错误，默认设置为2人" << endl;
		playnum = 2;
	}

	// start() 函数开头
	for (int i = 0; i < 10; i++) A[i].alive = false;  // 重置所有玩家状态
	for (int i = 0; i < playnum; i++) {
		A[i].id = i;
		A[i].alive = true;  // 仅激活选中的玩家
		cout << "请输入" << i << "号玩家的姓名：";
		cin >> A[i].name;
	}

	int alivenum;
	do {
		num++; // 回合数增加
		alivenum = 0;
		cout << "\n========== 第 " << num << " 轮游戏开始 ==========" << endl;
		// 统计存活玩家数量
		for (int i = 0; i < playnum; i++)
		{
			if (A[i].alive == true)
				alivenum++;
		}
		if (!(alivenum > 1))
			break;

		// ==========================================
		// 新增：1. 利息结算阶段 (每回合开始先算利息)
		// ==========================================
		cout << "\n----- 阶段1：利息结算 -----" << endl;
		cout << "\n>>> 正在进行回合 " << num << " 的利息结算..." << endl;

		// 结算银行贷款利息
		for (int i = 0; i < bln; i++) {
			if (bankloan[i].effect == true) {
				bankloan[i].change();
			}
		}

		// 结算私人借贷利息
		for (int i = 0; i < pln; i++) {
			if (playerloan[i].effect == true) {
				playerloan[i].change();
			}
		}
		cout << "利息结算完成。" << endl;
		system("pause");
		// ==========================================
// 新增：2. 银行贷款强制还款检查（每回合执行）
// ==========================================
		cout << "\n----- 阶段2：银行贷款逾期检查 -----" << endl;
		cout << "\n>>> 检查银行贷款强制还款条件..." << endl;
		for (int i = 0; i < bln; i++) { // 遍历所有银行贷款记录
			if (bankloan[i].effect == true) { // 仅处理有效借条
				// 条件：借款超过3回合（当前回合-借款回合≥3）
				if (bankloan[i].time <= num - 3) {
					cout << "发现逾期贷款：玩家" << bankloan[i].A->name << "的贷款已超3回合。" << endl;
					repayCompulsory(&bankloan[i]); // 调用强制还款函数
					system("pause");
				}
			}
		}
		cout << "银行贷款强制还款检查完成。" << endl;
		if (num % 3 == 0) {
			cout << "\n>>> 注意，本回合是纳税回合 <<<" << endl;
			system("pause");
		}
			// ==========================================
			// 2. 显示财务状况
			// ==========================================
		cout << "\n----- 阶段3：显示财务状况 -----" << endl;
			for (int i = 0; i < playnum; i++)
			{
				if (A[i].alive == true) {
					cout << "轮到 " << A[i].name << " 查看财务状况..." << endl;
					A[i].financialshow();
					system("pause");
				}
			}

			// ==========================================
			// 3. 玩家行动阶段
			// ==========================================
			cout << "\n----- 阶段4：玩家行动 -----" << endl;
			for (int i = 0; i < playnum; i++)
			{
				if (A[i].alive == true)
				{
					choose(A[i], playnum);
				}
			}

			// ==========================================
			// 4. 赌博阶段
			// ==========================================
			cout << "\n----- 阶段5：赌博游戏 -----" << endl;
			gamble(playnum);

			// ==========================================
			// 5. 纳税阶段 (每3回合一次)
			// ==========================================
			if (num % 3 == 0) {
				cout << "\n----- 阶段6：纳税阶段 -----" << endl;
				cout << "\n>>> 纳税开始 <<<" << endl;
				for (int i = 0; i < playnum; i++)
				{
					if (A[i].alive == true)
						tax(A[i]);
				}
			}

		} while (alivenum > 1);

		// 游戏结束判定
		cout << "\n========== 游戏结束 ==========" << endl;
		if (alivenum == 1)
		{
			int i = 0;
			for (; i < playnum; i++)
			{
				if (A[i].alive == true)
					break;
			}
			cout << "恭喜玩家 " << i << "号 " << A[i].name << " 成为大富翁！" << endl;
			system("pause");
			cout << "游戏结束，烟花表演" << endl;
			system("pause");
			firework();
		}
		else
		{
			cout << "全员破产！无人获胜。" << endl;
			system("pause");
			cout << "游戏结束，烟花表演" << endl;
			system("pause");
			firework();
		}
	}

// 主函数
int main()
{
	game B;
	B.start();
	return 0;
}